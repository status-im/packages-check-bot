// Checks API example
// See: https://developer.github.com/v3/checks/ to learn more
import { Application, Context } from 'probot' // eslint-disable-line no-unused-vars
import Octokit from '@octokit/rest'
import Humanize from 'humanize-plus'
import { checkDependenciesAsync, getDependenciesFromJSON, AnalysisResult, AnnotationResult } from './dependency-check'

const pendingChecks: any = []

export = (app: Application) => {
  app.on(['check_suite.requested'], async (context) => { await checkSuiteAsync(context, context.payload.check_suite) })
  app.on(['check_suite.completed'], async (context) => { delete pendingChecks[context.payload.check_suite.head_sha] })
  app.on(['check_run.rerequested'], async (context) => {
    const { check_suite } = context.payload.check_run
    await checkSuiteAsync(context, check_suite)
  })

  async function checkSuiteAsync (context: Context, checkSuite: Octokit.ChecksCreateSuiteResponse): Promise<Octokit.Response<Octokit.ChecksCreateResponse>> {
    const { head_branch: headBranch, head_sha: headSHA } = checkSuite

    // Probot API note: context.repo() => {username: 'hiimbex', repo: 'testing-things'}
    const check: Octokit.ChecksCreateParams = context.repo({
      name: 'packages-check-bot',
      head_branch: headBranch,
      head_sha: headSHA,
      started_at: (new Date()).toISOString()
    })

    try {
      context.log.info(`checking ${context.payload.repository.full_name}#${headBranch} (${headSHA}) (check_suite.id #${checkSuite.id})
Pull requests: ${Humanize.oxford(checkSuite.pull_requests.map(pr => pr.url), 5)}`)

      check.status = 'in_progress'
      check.output = {
        title: 'package.json check',
        summary: 'Checking any new/updated dependencies...'
      }

      const alreadyQueued = pendingChecks[headSHA]

      if (context.payload.action === 'rerequested') {
        if (!alreadyQueued) {
          pendingChecks[headSHA] = { ...check, check_run_id: context.payload.check_run.id }
          queueCheckAsync(context, checkSuite)
        }

        const createResponse = await context.github.checks.create(check)
        context.log.debug(`create checks status: ${createResponse.status}`)
        return createResponse
      } else {
        if (!alreadyQueued) {
          pendingChecks[headSHA] = { ...check }
        }
        const createResponse = await context.github.checks.create(check)
        context.log.debug(`create checks status: ${createResponse.status}`)

        if (!alreadyQueued) {
          pendingChecks[headSHA] = { ...check, check_run_id: createResponse.data.id }
          queueCheckAsync(context, checkSuite)
        }
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

const timeout = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

class FileItem {
  filename!: string
  status!: string

  constructor (filename: string, status: string) {
    this.filename = filename
    this.status = status
  }
}

async function queueCheckAsync (context: Context, checkSuite: Octokit.ChecksCreateSuiteResponse) {
  try {
    const { before, head_sha: headSHA } = checkSuite

    let files: FileItem[] = await getFilesToBeAnalyzedAsync(context, checkSuite)

    context.log.info(`Starting analysis of ${files.length} files (before: ${before}, head: ${headSHA})`)

    let check = pendingChecks[headSHA]
    if (!check) {
      // Check must have been finished by another bot instance, do nothing
      return
    }

    const packageFilenameRegex = /^(.*\/)?package\.json(.orig)?$/g

    if (!check.output) {
      const output: Octokit.ChecksUpdateParamsOutput = {
        summary: ''
      }
      check.output = output
    }
    check.output.annotations = undefined

    let analysisResult = new AnalysisResult()

    for (const file of files) {
      switch (file.status) {
        case 'added':
        case 'modified':
          if (packageFilenameRegex.test(file.filename)) {
            analysisResult.addPackageJSONFilename(file.filename)
            await checkPackageFileAsync(analysisResult, context, file.filename, headSHA)
          }
          break
      }
    }

    prepareCheckRunUpdate(check, analysisResult)

    if (analysisResult.annotations.length === 0) {
      await updateRunAsync(context, check)
    } else {
      for (let annotationIndex = 0; annotationIndex < analysisResult.annotations.length; annotationIndex += 50) {
        const annotationsSlice = analysisResult.annotations.length > 50 ? analysisResult.annotations.slice(annotationIndex, annotationIndex + 50) : analysisResult.annotations

        check.output.annotations = convertAnnotationResults(check, annotationsSlice)
        await updateRunAsync(context, check)
      }
    }
    delete pendingChecks[headSHA]
  } catch (error) {
    context.log.error(error)
    // This function isn't usually awaited for, so there's no point in rethrowing
  }
}

async function getFilesToBeAnalyzedAsync (context: Context, checkSuite: Octokit.ChecksCreateSuiteResponse): Promise<FileItem[]> {
  let files: FileItem[] = []

  try {
    if (checkSuite.before === '0000000000000000000000000000000000000000') {
      const getCommitResponse = await context.github.repos.getCommit(context.repo({
        sha: checkSuite.head_sha
      }))
      context.log.debug(`get commit status: ${getCommitResponse.status}, ${getCommitResponse.data.files.length} file(s)`)

      files = getCommitResponse.data.files.map((f: Octokit.ReposGetCommitResponseFilesItem) => new FileItem(f.filename, f.status))
    } else {
      const compareResponse = await context.github.repos.compareCommits(context.repo({
        base: checkSuite.before,
        head: checkSuite.head_sha
      }))
      context.log.debug(`compare commits status: ${compareResponse.status}, ${compareResponse.data.files.length} file(s)`)

      files = compareResponse.data.files.map((f: any) => new FileItem(f.filename, f.status))
    }
  } catch (error) {
    context.log.error(error)
  }

  return files
}

function prepareCheckRunUpdate (check: Octokit.ChecksUpdateParams, analysisResult: AnalysisResult) {
  check.status = 'completed'
  check.completed_at = (new Date()).toISOString()

  if (analysisResult.checkedDependencyCount === 0) {
    check.conclusion = 'neutral'
    if (check.output) {
      check.output.summary = 'No changes to dependencies'
    }
  } else if (analysisResult.annotations.length === 0) {
    check.conclusion = 'success'
    if (check.output) {
      check.output.summary = 'All dependencies are good!'
    }
  } else {
    check.conclusion = 'failure'

    if (check.output) {
      const warnings = analysisResult.annotations.filter(a => a.annotationLevel === 'warning').length
      const failures = analysisResult.annotations.filter(a => a.annotationLevel === 'failure').length
      const uniqueProblemDependencies = [...new Set(analysisResult.annotations.map(a => a.dependency.name))]
      check.output.summary = `Checked ${analysisResult.checkedDependencyCount} ${Humanize.pluralize(analysisResult.checkedDependencyCount, 'dependency', 'dependencies')} in ${Humanize.oxford(analysisResult.packageJsonFilenames.map(f => `\`${f}\``), 3)}.
${Humanize.boundedNumber(failures, 10)} ${Humanize.pluralize(failures, 'failure')}, ${Humanize.boundedNumber(warnings, 10)} ${Humanize.pluralize(warnings, 'warning')} in ${Humanize.oxford(uniqueProblemDependencies.map(f => `\`${f}\``), 3)} need your attention!`
    }
  }
}

async function updateRunAsync (context: Context, check: Octokit.ChecksUpdateParams) {
  for (let attempts = 3; attempts >= 0;) {
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

async function checkPackageFileAsync (analysisResult: AnalysisResult, context: Context, filename: string, headSHA: string) {
  const contentsResponse: any = await context.github.repos.getContents(context.repo({
    path: filename,
    ref: headSHA
  }))
  context.log.debug(`get contents response: ${contentsResponse.status}`)
  if (contentsResponse.status >= 300) {
    throw new Error(`HTTP error ${contentsResponse.status} (${contentsResponse.statusText}) fetching ${filename}`)
  }

  const contents = Buffer.from(contentsResponse.data.content, 'base64').toString('utf8')
  const contentsJSON = JSON.parse(contents)

  await checkDependenciesAsync(context, contents, getDependenciesFromJSON(contentsJSON.dependencies), filename, analysisResult)
  await checkDependenciesAsync(context, contents, getDependenciesFromJSON(contentsJSON.devDependencies), filename, analysisResult)
  await checkDependenciesAsync(context, contents, getDependenciesFromJSON(contentsJSON.optionalDependencies), filename, analysisResult)
}

function convertAnnotationResults (check: Octokit.ChecksUpdateParams, annotationsSlice: AnnotationResult[]): Octokit.ChecksUpdateParamsOutputAnnotations[] {
  let annotations: Octokit.ChecksUpdateParamsOutputAnnotations[] = []

  for (const annotationResult of annotationsSlice) {
    const annotation: Octokit.ChecksUpdateParamsOutputAnnotations = {
      path: annotationResult.path,
      start_line: annotationResult.startLine,
      end_line: annotationResult.endLine,
      annotation_level: annotationResult.annotationLevel,
      message: annotationResult.message,
      title: annotationResult.title,
      raw_details: annotationResult.rawDetails
    }
    annotations.push(annotation)
  }

  return annotations
}
