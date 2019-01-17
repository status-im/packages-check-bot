// Checks API example
// See: https://developer.github.com/v3/checks/ to learn more
const pendingChecks = []

const checkDependencies = require('./lib/dependency-check')
const Humanize = require('humanize-plus')

module.exports = app => {
  app.on(['check_suite.requested'], checkSuiteRequested)
  app.on(['check_run.rerequested'], checkRunRerequested)

  async function checkSuiteRequested(context) {
    if (context.isBot) {
      return
    }

    return await checkSuiteAsync(context, context.payload.check_suite)
  }

  async function checkRunRerequested(context) {
    if (context.isBot) {
      return
    }

    const { check_suite } = context.payload.check_run
    return await checkSuiteAsync(context, check_suite)
  }

  async function checkSuiteAsync(context, check_suite) {
    const { head_branch, head_sha } = check_suite

    // Probot API note: context.repo() => {username: 'hiimbex', repo: 'testing-things'}
    const check = context.repo({
      name: 'packages-check-bot',
      head_branch: head_branch,
      head_sha: head_sha,
      started_at: (new Date()).toISOString()
    })

    try {
      if (pendingChecks[head_sha]) {
        // Already running, ignore
        return
      }

      context.log.info(`checking ${context.payload.repository.full_name}#${head_branch} (${head_sha}) (check_suite.id #${check_suite.id})
Pull requests: ${Humanize.oxford(check_suite.pull_requests.map(pr => pr.url), 5)}`)

      check.status = 'in_progress'
      check.output = {
        title: 'package.json check',
        summary: 'Checking any new/updated dependencies...'
      }

      if (context.payload.action === 'rerequested') {
        pendingChecks[head_sha] = { ...check, check_run_id: context.payload.check_run.id }
        queueCheckAsync(context, check_suite)
        return
      } else {
        pendingChecks[head_sha] = { ...check }
        const createResponse = await context.github.checks.create(check)
        context.log.debug(`create checks status: ${createResponse.status}`)

        pendingChecks[head_sha] = { ...check, check_run_id: createResponse.data.id }
        queueCheckAsync(context, check_suite)
        return createResponse
      }
    } catch (e) {
      context.log.error(e)

      // Report error back to GitHub
      check.status = 'completed'
      check.conclusion = 'cancelled'
      check.completed_at = (new Date()).toISOString()
      check.output = {
        title: 'package.json check',
        summary: e.message
      }

      return context.github.checks.create(check)
    }
  }

  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/
}

const timeout = ms => new Promise(res => setTimeout(res, ms))

async function queueCheckAsync(context, check_suite) {
  try {
    const { before, head_sha } = check_suite

    const compareResponse = await context.github.repos.compareCommits(context.repo({
      base: before,
      head: head_sha
    }))
    context.log.debug(`compare commits status: ${compareResponse.status}, ${compareResponse.data.files.length} file(s)`)

    let check = pendingChecks[head_sha]
    let checkedDepCount = 0
    let packageJsonFilenames = []
    const packageFilenameRegex = /^package\.json(.orig)?$/g
  
    check.output.annotations = undefined
    for (const file of compareResponse.data.files) {
      switch (file.status) {
      case 'added':
      case 'modified':
        if (packageFilenameRegex.test(file.filename)) {
          packageJsonFilenames.push(file.filename)
          checkedDepCount += await checkPackageFileAsync(check, context, file, head_sha)
        }
        break
      }
    }

    check.status = 'completed'
    check.completed_at = (new Date()).toISOString()
  
    if (!check.output.annotations) {
      check.conclusion = 'neutral'
      check.output.summary = 'No changes to dependencies'
    } else if (check.output.annotations.length === 0) {
      check.conclusion = 'success'
      check.output.summary = 'All dependencies are good!'
    } else {
      check.conclusion = 'failure'

      const warnings = check.output.annotations.filter(a => a.annotation_level === 'warning').length
      const failures = check.output.annotations.filter(a => a.annotation_level === 'failure').length
      const uniqueProblemDependencies = [...new Set(check.output.annotations.map(a => a.dependency))]
      check.output.summary = `Checked ${checkedDepCount} ${Humanize.pluralize(checkedDepCount, 'dependency', 'dependencies')} in ${Humanize.oxford(packageJsonFilenames.map(f => `\`${f}\``), 3)}.
${Humanize.boundedNumber(failures, 10)} ${Humanize.pluralize(failures, 'failure')}, ${Humanize.boundedNumber(warnings, 10)} ${Humanize.pluralize(warnings, 'warning')} in ${Humanize.oxford(uniqueProblemDependencies.map(f => `\`${f}\``), 3)} need your attention!`
    }
  
    // Remove helper data from annotation objects
    const annotations = check.output.annotations
    for (const annotation of annotations) {
      delete annotation['dependency']
    }

    for (let annotationIndex = 0; annotationIndex < annotations.length; annotationIndex += 50) {
      const annotationsSlice = annotations.length > 50 ? annotations.slice(annotationIndex, annotationIndex + 50) : annotations
      check.output.annotations = annotationsSlice

      for (let attempts = 3; attempts >= 0; ) {
        try {
          const updateResponse = await context.github.checks.update({
            owner: check.owner,
            repo: check.repo,
            check_run_id: check.check_run_id,
            name: check.name,
            //details_url: check.details_url,
            external_id: check.external_id,
            started_at: check.started_at,
            status: check.status,
            conclusion: check.conclusion,
            completed_at: check.completed_at,
            output: check.output
          })
          context.log.debug(`update checks status: ${updateResponse.status}`)
          break
        } catch (error) {
          if (--attempts <= 0) {
            throw error
          }
          context.log.warn(`error while updating check run, will try again in 30 seconds: ${error.message}`)
          await timeout(30000)
        }
      }
    }
    check.output.annotations = annotations
    delete pendingChecks[head_sha]
  } catch (error) {
    context.log.error(error)
    // This function isn't usually awaited for, so there's no point in rethrowing 
  }
}

async function checkPackageFileAsync(check, context, file, head_sha) {
  const contentsResponse = await context.github.repos.getContents(context.repo({
    path: file.filename,
    ref: head_sha
  }))
  context.log.debug(`get contents response: ${contentsResponse.status}`)
  if (contentsResponse.status >= 300) {
    throw new `HTTP error ${contentsResponse.status} (${contentsResponse.statusText}) fetching ${file.filename}`
  }

  const contents = Buffer.from(contentsResponse.data.content, 'base64').toString('utf8')
  const contentsJSON = JSON.parse(contents)
  let dependencyCount = 0

  dependencyCount += checkDependencies(contents, contentsJSON.dependencies, file, check)
  dependencyCount += checkDependencies(contents, contentsJSON.devDependencies, file, check)
  dependencyCount += checkDependencies(contents, contentsJSON.optionalDependencies, file, check)

  return dependencyCount
}
