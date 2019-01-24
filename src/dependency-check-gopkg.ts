import { Context } from 'probot' // eslint-disable-line no-unused-vars
import toml from 'toml'

import { AnalysisResult } from './analysis-result'
import { createAnnotation } from './annotation-result'
import { AnnotationSource } from './annotation-source'
import { Dependency, GitRefType } from './dependency'

type RawGopkgRefType = 'version' | 'branch' | 'revision'

interface GopkgLockProject {
  digest: string,
  name: string,
  source?: string,
  packages: string[],
  pruneopts?: string,

  revision: string,
  branch?: string,
  version?: string,
}

interface GopkgTomlOverride {
  name: string,
  source?: string,
  metadata?: any,

  revision?: string,
  branch?: string,
  version?: string,
}

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
  const gopkgLockContents = Buffer.from(gopkgLockContentsResponse.data.content, 'base64').toString('utf8')
  const gopkgTomlContentsJson = toml.parse(gopkgTomlContents)
  const gopkgLockContentsJson = toml.parse(gopkgLockContents)

  await checkGoDependenciesAsync(
    gopkgTomlContents, gopkgLockContents,
    getDependenciesFromGopkg(gopkgTomlContentsJson, gopkgLockContentsJson),
    gopkgTomlFilename, gopkgLockFilename,
    analysisResult)
}

function getDependenciesFromGopkg(gopkgTomlContentsJson: any, gopkgLockContentsJson: any): Dependency[] {
  const dependencies: Dependency[] = []

  for (const tomlDep of gopkgLockContentsJson.projects as GopkgLockProject[]) {
    const rawRefType = getRawRefType(gopkgTomlContentsJson, tomlDep)
    dependencies.push({
      name: tomlDep.name,
      url: tomlDep.source ? tomlDep.source : tomlDep.name,

      rawRefType,
      refName: rawRefType ? (tomlDep as any)[rawRefType] : undefined,
      refType: getRefType(rawRefType),
    })
  }

  return dependencies
}

function getRawRefType(gopkgTomlContentsJson: any, tomlDep: GopkgLockProject): RawGopkgRefType | undefined {
  const findConstraint =
    (constraints: GopkgTomlOverride[], depName: string) =>
      (constraints ? constraints.find((o: GopkgTomlOverride) => o.name === depName) : undefined)

  const constraint: GopkgTomlOverride | undefined =
    findConstraint(gopkgTomlContentsJson.constraint, tomlDep.name) ||
    findConstraint(gopkgTomlContentsJson.override, tomlDep.name)
  if (constraint) {
    if (constraint.version) {
      return 'version'
    } else if (constraint.branch) {
      return 'branch'
    } else if (constraint.revision) {
      return 'revision'
    }
  }

  if (tomlDep.version) {
    return 'version'
  } else if (tomlDep.branch) {
    return 'branch'
  } else if (tomlDep.revision) {
    return 'revision'
  }

  return undefined
}

function getRefType(rawRefType: RawGopkgRefType | undefined): GitRefType | undefined {
  switch (rawRefType) {
    case 'version':
      return 'tag'
    case 'branch':
      return 'branch'
    case 'revision':
      return 'commit'
    default:
      return undefined
  }
}

interface SearchArgs {
  projectName: string,
  projectLineSubstring: string
}

export function findLineInTomlFileContent(contents: string, searchArgs: SearchArgs): number {
  const projectNameIndex = contents.indexOf(searchArgs.projectName)
  if (projectNameIndex < 0) {
    return -1
  }

  const projectStartIndex = contents.lastIndexOf('[[', projectNameIndex)
  if (projectStartIndex < 0) {
    return projectNameIndex
  }
  const index = contents.indexOf(searchArgs.projectLineSubstring, projectStartIndex)
  if (index < 0) {
    return projectNameIndex
  }

  const line = contents.substr(0, index).split('\n').length

  return line
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
    const name = dependency.name
    const refType = dependency.refType
    if (!refType) {
      continue
    }

    const searchArgs: SearchArgs = {
      projectLineSubstring: `${dependency.rawRefType} = "${dependency.refName}"`,
      projectName: `name = "${name}"`,
    }
    let line = findLineInTomlFileContent(gopkgTomlContents, searchArgs)
    let filename = gopkgTomlFilename
    if (line < 0) {
      line = findLineInTomlFileContent(gopkgLockContents, searchArgs)
      filename = gopkgLockFilename
    }

    const annotation: AnnotationSource = {
      dependency,
      filename,
      line,
    }
    const newAnnotation = (level: 'notice' | 'warning' | 'failure', message: string) => {
      const title = `Dependency '${name}' is locked with ${dependency.rawRefType} '${dependency.refName}'.`
      result.annotations.push(createAnnotation(annotation, level, title, message))
    }
    switch (refType) {
      case 'tag':
        continue
      case 'commit':
        newAnnotation('notice',
                      `A commit SHA is not a deterministic dependency locator.
If the commit is overwritten by a force-push, it will be impossible to rebuild the same output in the future.

Please lock the dependency with a tag/release.`,
        )
        break
      case 'branch':
        newAnnotation('notice', // TODO: change this to 'failure' once we've fixed issues in the codebase
                      `A branch is not a deterministic dependency locator.
If the branch advances, it will be impossible to rebuild the same output in the future.

Please lock the dependency with a tag/release.`,
        )
        break
    }
  }
}
