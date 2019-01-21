import { Context } from 'probot' // eslint-disable-line no-unused-vars
import toml from 'toml'
import { AnalysisResult } from './analysis-result'
import { Dependency } from './dependency'
import { AnnotationSource,
         createAnnotation,
         findLineInFileContent } from './dependency-check'

export async function checkGopkgFileAsync(
  analysisResult: AnalysisResult,
  context: Context,
  gopkgTomlFilename: string,
  gopkgLockFilename: string,
  headSHA: string,
) {
  const gopkgTomlContentsResponse: any =
    await context.github.repos.getContents(context.repo({ path: gopkgTomlFilename, ref: headSHA }))
  context.log.debug(`get contents response for ${gopkgTomlFilename}: ${gopkgTomlContentsResponse.status}`)

  const gopkgLockContentsResponse: any =
    await context.github.repos.getContents(context.repo({ path: gopkgLockFilename, ref: headSHA }))
  context.log.debug(`get contents response for ${gopkgLockFilename}: ${gopkgLockContentsResponse.status}`)

  const gopkgTomlContents = Buffer.from(gopkgTomlContentsResponse.data.content, 'base64').toString('utf8')
  const gopkgTomlContentsToml = toml.parse(gopkgTomlContents)
  const gopkgLockContents = Buffer.from(gopkgLockContentsResponse.data.content, 'base64').toString('utf8')
  const gopkgLockContentsToml = toml.parse(gopkgLockContents)

  await checkGoDependenciesAsync(
    gopkgTomlContents, gopkgLockContents,
    getDependenciesFromGopkg(gopkgTomlContentsToml, gopkgLockContentsToml),
    gopkgTomlFilename, gopkgLockFilename,
    analysisResult)
}

function getDependenciesFromGopkg(gopkgTomlContentsToml: any, gopkgLockContentsToml: any): Dependency[] {
  const dependencies: Dependency[] = []

  for (const tomlDep of gopkgLockContentsToml.projects) {
    dependencies.push({
      name: tomlDep.name,
      url: tomlDep.source ? tomlDep.source : tomlDep.name,

      refType: getRefType(gopkgTomlContentsToml, tomlDep),
    })
  }

  return dependencies
}

function getRefType(gopkgTomlContentsToml: any, tomlDep: any): 'commit' | 'tag' | 'branch' | 'unknown' {
  if (tomlDep.version) {
    return 'tag'
  } else if (tomlDep.branch) {
    return 'branch'
  } else {
    const override: any = gopkgTomlContentsToml.override.find((o: any) => o.name === tomlDep.name)
    if (override && override.revision) {
      return 'commit'
    }
  }

  return 'unknown'
}

export async function checkGoDependenciesAsync(
  gopkgTomlContents: string, gopkgLockContents: string,
  dependencies: Dependency[],
  gopkgTomlFilename: string, gopkgLockFilename: string,
  result: AnalysisResult,
) {
  if (!dependencies || dependencies.length === 0) {
    return
  }

  // tslint:disable-next-line:max-line-length
  result.checkedDependencyCount += dependencies.length

  for (const dependency of dependencies) {
    const url = dependency.url
    let line = findLineInFileContent(gopkgTomlContents, `name = "${url}"`)
    let filename = gopkgTomlFilename
    if (line < 0) {
      line = findLineInFileContent(gopkgLockContents, `name = "${url}"`)
      filename = gopkgLockFilename
    }
    const refType = dependency.refType
    if (!refType) {
      continue
    }

    const annotation: AnnotationSource = {
      dependency,
      filename,
      line,
    }
    const newAnnotation = (level: 'notice' | 'warning' | 'failure', title: string, message: string) => {
      result.annotations.push(createAnnotation(annotation, level, title, message))
    }
    switch (refType) {
      case 'tag':
        continue
      case 'commit':
        newAnnotation('notice', `Dependency '${url}' is not locked with a tag/release.`,
                      `A commit SHA is not a deterministic dependency locator.
If the commit is overwritten by a force-push, it will be impossible to rebuild the same output in the future.`,
        )
        break
      case 'branch':
        newAnnotation('notice', // TODO: change this to 'failure' once we've fixed issues in the codebase
                      `Dependency '${url}' is not locked with a tag/release.`,
                      `A branch is not a deterministic dependency locator.
If the branch advances, it will be impossible to rebuild the same output in the future.`,
        )
        break
    }
  }
}
