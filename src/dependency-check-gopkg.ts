import { Context } from 'probot' // eslint-disable-line no-unused-vars
import { toml } from 'toml'
import { AnalysisResult } from './analysis-result'
import { Dependency } from './dependency'
import { checkDependenciesAsync } from './dependency-check'

export async function checkGopkgFileAsync(
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
  const contentsToml = toml.parse(contents)
  const doAsync = (deps: any) => {
    return checkDependenciesAsync(
      context,
      contents,
      getDependenciesFromGopkg(deps),
      filename,
      analysisResult)
  }

  await doAsync(contentsToml.constraint)
}

function getDependenciesFromGopkg(dependenciesToml: any): Dependency[] {
  const dependencies: Dependency[] = []

  for (const tomlDep of dependenciesToml) {
    dependencies.push({
      name: tomlDep.name,
      url: tomlDep.source ? tomlDep.source : tomlDep.name,
      refType: getRefType(tomlDep)
    })
  }

  return dependencies
}

function getRefType(tomlDep: any): 'tag' | 'branch' | 'unknown' {
  if (tomlDep.revision) {
    return 'commit'
  } else if (tomlDep.version) {
    return 'tag'
  } else if (tomlDep.branch) {
    return 'branch'
  }
}