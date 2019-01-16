// Checks API example
// See: https://developer.github.com/v3/checks/ to learn more
const pendingChecks = []

const Humanize = require('humanize-plus')

module.exports = app => {
  app.on(['check_suite.requested'], checkSuiteRequested)
  app.on(['check_run.rerequested'], checkRunRerequested)

  async function checkSuiteRequested(context) {
    if (context.isBot) {
      return
    }

    await checkSuiteAsync(context, context.payload.check_suite)
  }

  async function checkRunRerequested(context) {
    if (context.isBot) {
      return
    }

    const { check_suite } = context.payload.check_run
    await checkSuiteAsync(context, check_suite)
  }

  async function checkSuiteAsync(context, check_suite) {
    // Do stuff
    try {
      const { head_branch, head_sha } = check_suite
      if (pendingChecks[head_sha]) {
        // Already running, ignore
        return
      }

      // Probot API note: context.repo() => {username: 'hiimbex', repo: 'testing-things'}
      const check = context.repo({
        name: 'packages-check-bot',
        head_branch: head_branch,
        head_sha: head_sha,
        status: 'in_progress',
        started_at: (new Date()).toISOString(),
        output: {
          title: 'package.json check',
          summary: 'Checking any new/updated dependencies...'
        }
      })

      if (context.payload.action === 'rerequested') {
        pendingChecks[head_sha] = { ...check, check_run_id: context.payload.check_run.id }
        queueCheckAsync(context, check_suite)
        return {statusCode: 200}
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
      // TODO: Check what is the right way to exit here, since it seems this causes the bot to not be responsive afterward
      throw e
    }
  }

  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/
}

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
      }) // TODO: Handle error
      context.log.debug(`update checks status: ${updateResponse.status}`)
    }
    check.output.annotations = annotations
    delete pendingChecks[head_sha]
  } catch (error) {
    context.log.error(error)
    throw error
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

function checkDependencies(contents, dependencies, file, check) {
  if (!dependencies) {
    return 0
  }

  const urlRegex = /^(http:\/\/|https:\/\/|git\+http:\/\/|git\+https:\/\/|ssh:\/\/|git\+ssh:\/\/|github:)([a-zA-Z0-9_\-./]+)(#(.*))?$/gm
  const requiredProtocol = 'git+https://'
  let dependencyCount = 0

  for (const dependency in dependencies) {
    if (dependencies.hasOwnProperty(dependency)) {
      ++dependencyCount

      const url = dependencies[dependency]
      const match = urlRegex.exec(url)

      if (!match) {
        continue
      }
      const protocol = match[1]
      const address = match[2]
      const tag = match.length > 4 ? match[4] : null
      const { line } = findLineColumn(contents, contents.indexOf(url))
      const optimalAddress = address.endsWith('.git') ? address : address.concat('.git')
      const optimalTag = isTag(tag) ? tag : '#<release-tag>'
      const suggestedUrl = `${requiredProtocol}${optimalAddress}${optimalTag}`

      const annotationSource = {
        check: check,
        dependency: dependency,
        file: file,
        line: line
      }
      if (protocol !== requiredProtocol) {
        createAnnotation(annotationSource, suggestedUrl, {
          annotation_level: 'warning',
          title: `Found protocol ${protocol} being used in dependency`,
          message: `Protocol should be ${requiredProtocol}.`
        })
      }
      if (protocol !== 'github:' && !address.endsWith('.git')) {
        createAnnotation(annotationSource, suggestedUrl, {
          annotation_level: 'warning',
          title: 'Address should end with .git for consistency.',
          message: 'Android builds have been known to fail when dependency addresses don\'t end with .git.'
        })
      }
      if (!tag) {
        createAnnotation(annotationSource, suggestedUrl, {
          annotation_level: 'failure',
          title: 'Dependency is not locked with a tag/release.',
          message: `${url} is not a deterministic dependency locator.\r\nIf the branch advances, it will be impossible to rebuild the same output in the future.`
        })
      } else if (!isTag(tag)) {
        createAnnotation(annotationSource, suggestedUrl, {
          annotation_level: 'failure',
          title: 'Dependency is locked with a branch, instead of a tag/release.',
          message: `${url} is not a deterministic dependency locator.\r\nIf the branch advances, it will be impossible to rebuild the same output in the future.`
        })
      }
    }
  }

  return dependencyCount
}

function findLineColumn (contents, index) {
  const lines = contents.split('\n')
  const line = contents.substr(0, index).split('\n').length

  const startOfLineIndex = (() => {
    const x = lines.slice(0)
    x.splice(line - 1)
    return x.join('\n').length + (x.length > 0)
  })()

  const col = index - startOfLineIndex

  return { line, col }
}

function createAnnotation(annotationSource, suggestedUrl, annotation) {
  const { check, dependency, file, line } = annotationSource

  if (!check.output.annotations) {
    check.output.annotations = []
  }
  annotation.message = annotation.message.concat(`\r\n\r\nSuggested URL: ${suggestedUrl}`)
  check.output.annotations.push({
    ...annotation,
    dependency: dependency,
    path: file.filename,
    start_line: line,
    end_line: line,
    raw_details: `{suggestedUrl: ${suggestedUrl}}`
  })
}

function isTag(tag) {
  // TODO: We need to check the actual repo to see if it is a branch or a tag
  return tag && tag !== 'master' && tag !== 'develop'
}
