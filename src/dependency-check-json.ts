import { Context } from 'probot' // eslint-disable-line no-unused-vars
import { AnalysisResult } from './analysis-result'
import { Dependency } from './dependency'
import { checkDependenciesAsync } from './dependency-check'

export async function checkPackageFileAsync(
  analysisResult: AnalysisResult,
  context: Context,
  filename: string,
  headSHA: string,
) {
  const contentsResponse: any = await context.github.repos.getContents(context.repo({ path: filename, ref: headSHA }))
  context.log.debug(`get contents response: ${contentsResponse.status}`)
  if (contentsResponse.status >= 300) {
    throw new Error(`HTTP error ${contentsResponse.status} (${contentsResponse.statusText}) fetching ${filename}`)
  }

  const contents = Buffer.from(contentsResponse.data.content, 'base64').toString('utf8')
  const contentsJSON = JSON.parse(contents)
  const doAsync = (deps: any) =>
    checkDependenciesAsync(
        context,
        contents,
        getDependenciesFromJSON(deps),
        filename,
        analysisResult)

  await doAsync(contentsJSON.dependencies)
  await doAsync(contentsJSON.devDependencies)
  await doAsync(contentsJSON.optionalDependencies)
}

function getDependenciesFromJSON(dependenciesJSON: any): Dependency[] {
  const dependencies: Dependency[] = []

  for (const name in dependenciesJSON) {
    if (dependenciesJSON.hasOwnProperty(name)) {
      dependencies.push({ name, url: dependenciesJSON[name] })
    }
  }

  return dependencies
}
