// Checks API example
// See: https://developer.github.com/v3/checks/ to learn more
import Octokit from '@octokit/rest'
import Humanize from 'humanize-plus'
import { Application, Context } from 'probot' // eslint-disable-line no-unused-vars
import { AnalysisResult} from './analysis-result'
import { AnnotationResult } from './annotation-result'
import {
  checkDependenciesAsync,
  getDependenciesFromJSON,
} from './dependency-check'

const pendingChecks: any = []

export = (app: Application) => {
  app.on(['check_suite.requested'], async (context) => {
    await checkSuiteAsync(context, context.payload.check_suite)
  })
  app.on(['check_suite.completed'], async (context) => {
    delete pendingChecks[context.payload.check_suite.head_sha]
  })
  app.on(['check_run.rerequested'], async (context) => {
    const { check_suite } = context.payload.check_run
    await checkSuiteAsync(context, check_suite)
  })

  async function checkSuiteAsync(
    context: Context,
    checkSuite: Octokit.ChecksCreateSuiteResponse,
  ): Promise<Octokit.Response<Octokit.ChecksCreateResponse>> {
    const { head_branch: headBranch, head_sha: headSHA } = checkSuite

    // Probot API note: context.repo() => {username: 'hiimbex', repo: 'testing-things'}
    const check: Octokit.ChecksCreateParams = context.repo({
      name: 'packages-check-bot',

      head_branch: headBranch,
      head_sha: headSHA,

      started_at: new Date().toISOString(),
    })

    try {
      context.log.info(`checking ${context.payload.repository.html_url}/commits/${
        checkSuite.head_sha
      } (check_suite.id #${checkSuite.id})
Pull requests: ${Humanize.oxford(checkSuite.pull_requests.map((pr) => pr.url), 5)}`)

      check.status = 'in_progress'
      check.output = {
        summary: 'Checking any new/updated dependencies...',
        title: 'package.json check',
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
      check.completed_at = new Date().toISOString()
      check.output = {
        summary: e.message,
        title: 'package.json check',
      }

      return context.github.checks.create(check)
    }
  }

  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/
}

const timeout = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class FileItem {
  public filename!: string
  public status!: string

  constructor(filename: string, status: string) {
    this.filename = filename
    this.status = status
  }
}

async function queueCheckAsync(context: Context, checkSuite: Octokit.ChecksCreateSuiteResponse) {
  try {
    const { before, head_sha: headSHA } = checkSuite

    const files: FileItem[] = await getFilesToBeAnalyzedAsync(context, checkSuite)

    context.log.info(
      `Starting analysis of ${files.length} files (before: ${before}, head: ${headSHA})`,
    )

    const check = pendingChecks[headSHA]
    if (!check) {
      // Check must have been finished by another bot instance, do nothing
      return
    }

    const packageFilenameRegex = /^(.*\/)?package\.json(.orig)?$/g

    if (!check.output) {
      const output: Octokit.ChecksUpdateParamsOutput = {
        summary: '',
      }
      check.output = output
    }
    check.output.annotations = undefined

    const analysisResult = new AnalysisResult()

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
      for (
        let annotationIndex = 0;
        annotationIndex < analysisResult.annotations.length;
        annotationIndex += 50
      ) {
        const annotationsSlice =
          analysisResult.annotations.length > 50
            ? analysisResult.annotations.slice(annotationIndex, annotationIndex + 50)
            : analysisResult.annotations

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

async function getFilesToBeAnalyzedAsync(
  context: Context,
  checkSuite: Octokit.ChecksCreateSuiteResponse,
): Promise<FileItem[]> {
  let files: FileItem[] = []

  try {
    if (checkSuite.before === '0000000000000000000000000000000000000000') {
      const getCommitResponse = await context.github.repos.getCommit(
        context.repo({
          sha: checkSuite.head_sha,
        }),
      )
      context.log.debug(
        `get commit status: ${getCommitResponse.status}, ${
          getCommitResponse.data.files.length
        } file(s)`,
      )

      files = getCommitResponse.data.files.map(
        (f: Octokit.ReposGetCommitResponseFilesItem) => new FileItem(f.filename, f.status),
      )
    } else {
      const compareResponse = await context.github.repos.compareCommits(
        context.repo({
          base: checkSuite.before,
          head: checkSuite.head_sha,
        }),
      )
      context.log.debug(
        `compare commits status: ${compareResponse.status}, ${
          compareResponse.data.files.length
        } file(s)`,
      )

      files = compareResponse.data.files.map((f: any) => new FileItem(f.filename, f.status))
    }
  } catch (error) {
    context.log.error(error)
  }

  return files
}

function prepareCheckRunUpdate(check: Octokit.ChecksUpdateParams, analysisResult: AnalysisResult) {
  check.status = 'completed'
  check.completed_at = new Date().toISOString()

  if (analysisResult.checkedDependencyCount === 0) {
    check.conclusion = 'neutral'
    if (check.output) {
      check.output.title = 'No changes to dependencies'
      check.output.summary = 'No changes detected to package.json files'
    }
  } else if (analysisResult.annotations.length === 0) {
    check.conclusion = 'success'
    if (check.output) {
      check.output.title = 'All dependencies are good!'
      check.output.summary = `No problems detected in changes to ${Humanize.oxford(
        analysisResult.packageJsonFilenames.map((f) => `\`${f}\``),
        3,
      )}`
    }
  } else {
    check.conclusion = 'failure'

    if (check.output) {
      const warnings = analysisResult.annotations.filter((a) => a.annotationLevel === 'warning')
        .length
      const failures = analysisResult.annotations.filter((a) => a.annotationLevel === 'failure')
        .length
      const uniqueProblemDependencies = [
        ...new Set(analysisResult.annotations.map((a) => a.dependency.name)),
      ]
      check.output.title = `${Humanize.boundedNumber(failures + warnings, 10)} ${Humanize.pluralize(
        failures + warnings,
        'problem',
      )} detected`
      check.output.summary = `Checked ${analysisResult.checkedDependencyCount} ${Humanize.pluralize(
        analysisResult.checkedDependencyCount,
        'dependency',
        'dependencies',
      )} in ${Humanize.oxford(analysisResult.packageJsonFilenames.map((f) => `\`${f}\``), 3)}.
${Humanize.boundedNumber(failures, 10)} ${Humanize.pluralize(
        failures,
        'failure',
      )}, ${Humanize.boundedNumber(warnings, 10)} ${Humanize.pluralize(
        warnings,
        'warning',
      )} in ${Humanize.oxford(
        uniqueProblemDependencies.map((f) => `\`${f}\``),
        3,
      )} need your attention!`
    }
  }
}

async function updateRunAsync(context: Context, check: Octokit.ChecksUpdateParams) {
  for (let attempts = 3; attempts >= 0; ) {
    try {
      const updateResponse = await context.github.checks.update({
        check_run_id: check.check_run_id,
        name: check.name,

        owner: check.owner,
        repo: check.repo,

        // details_url: check.details_url,
        external_id: check.external_id,

        completed_at: check.completed_at,
        started_at: check.started_at,

        conclusion: check.conclusion,
        output: check.output,
        status: check.status,
      })
      context.log.info(
        `HTTP ${updateResponse.status} - Finished updating check run #${check.check_run_id} for ${
          context.payload.repository.html_url
        }/commits/${context.payload.check_suite.head_sha}: ${check.status}, ${check.conclusion}`,
      )
      break
    } catch (error) {
      if (--attempts <= 0) {
        throw error
      }
      context.log.warn(
        `error while updating check run, will try again in 30 seconds: ${error.message}`,
      )
      await timeout(30000)
    }
  }
}

async function checkPackageFileAsync(
  analysisResult: AnalysisResult,
  context: Context,
  filename: string,
  headSHA: string,
) {
  const contentsResponse: any = await context.github.repos.getContents(
    context.repo({
      path: filename,
      ref: headSHA,
    }),
  )
  context.log.debug(`get contents response: ${contentsResponse.status}`)
  if (contentsResponse.status >= 300) {
    throw new Error(
      `HTTP error ${contentsResponse.status} (${contentsResponse.statusText}) fetching ${filename}`,
    )
  }

  const contents = Buffer.from(contentsResponse.data.content, 'base64').toString('utf8')
  const contentsJSON = JSON.parse(contents)
  const doAsync = (deps: any) => {
    return checkDependenciesAsync(
      context,
      contents,
      getDependenciesFromJSON(deps),
      filename,
      analysisResult)
  }

  await doAsync(contentsJSON.dependencies)
  await doAsync(contentsJSON.devDependencies)
  await doAsync(contentsJSON.optionalDependencies)
}

function convertAnnotationResults(
  check: Octokit.ChecksUpdateParams,
  annotationsSlice: AnnotationResult[],
): Octokit.ChecksUpdateParamsOutputAnnotations[] {
  const annotations: Octokit.ChecksUpdateParamsOutputAnnotations[] = []

  for (const annotationResult of annotationsSlice) {
    const annotation: Octokit.ChecksUpdateParamsOutputAnnotations = {
      annotation_level: annotationResult.annotationLevel,
      path: annotationResult.path,

      end_line: annotationResult.endLine,
      start_line: annotationResult.startLine,

      message: annotationResult.message,
      raw_details: annotationResult.rawDetails,
      title: annotationResult.title,
    }
    annotations.push(annotation)
  }

  return annotations
}
