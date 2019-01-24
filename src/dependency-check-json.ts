import { Context } from 'probot' // eslint-disable-line no-unused-vars

import { AnalysisResult } from './analysis-result'
import { createAnnotation } from './annotation-result'
import { AnnotationSource } from './annotation-source'
import { Dependency } from './dependency'
import { findLineInFileContent,
         slowGetRefTypeAsync } from './utils'

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

async function checkDependenciesAsync(
  context: Context,
  contents: string,
  dependencies: Dependency[],
  filename: string,
  result: AnalysisResult,
) {
  if (!dependencies || dependencies.length === 0) {
    return
  }

  // tslint:disable-next-line:max-line-length
  const urlRegex = /^(http:\/\/|https:\/\/|git\+http:\/\/|git\+https:\/\/|ssh:\/\/|git\+ssh:\/\/|github:)([a-zA-Z0-9_\-./]+)(#(.*))?$/gm
  const requiredProtocol = 'git+https://'

  result.checkedDependencyCount += dependencies.length

  for (const dependency of dependencies) {
    const url = dependency.url
    const match = urlRegex.exec(url)
    if (!match) {
      continue
    }

    const protocol = match[1]
    const address = protocol === 'github:' ? `github.com/${match[2]}` : match[2]
    const tag = match.length > 4 ? match[4] : ''
    const line = findLineInFileContent(contents, url)
    const optimalAddress = address.endsWith('.git') ? address : address.concat('.git')
    const refType = dependency.refType ? dependency.refType : await slowGetRefTypeAsync(context, address, tag)
    const optimalTag = refType === 'tag' ? tag : '#<release-tag>'
    const suggestedUrl = `${requiredProtocol}${optimalAddress}${optimalTag}`

    const annotation: AnnotationSource = {
      dependency,
      filename,
      line,
    }
    const newAnnotation = (level: 'notice' | 'warning' | 'failure', title: string, message: string) => {
      result.annotations.push(createAnnotation(annotation,
                                               level, title,
                                               message.concat(`\r\n\r\nSuggested URL: ${suggestedUrl}`)))
    }
    if (protocol !== requiredProtocol) {
      newAnnotation('warning', `Found protocol ${protocol} being used in dependency`,
                    `Protocol should be ${requiredProtocol}.`)
    }
    if (protocol !== 'github:' && !address.endsWith('.git')) {
      newAnnotation('warning', 'Address should end with .git for consistency.',
                    `Android builds have been known to fail when dependency addresses don't end with .git.`,
      )
    }
    if (!tag) {
      newAnnotation('failure', 'Dependency is not locked with a tag/release.',
                    `${url} is not a deterministic dependency locator.
If the branch advances, it will be impossible to rebuild the same output in the future.`,
      )
    } else if (refType === undefined) {
      newAnnotation('failure', `Dependency is locked with an unknown ref-spec (\`${tag}\`).`,
                    `Please check that the tag \`${tag}\` exists in the target repository ${address}.`,
      )
    } else if (refType === 'commit') {
      newAnnotation('notice', 'Dependency is locked with a commit instead of a tag/release.',
                    `${url} is not a deterministic dependency locator.
If the commit is overwritten by a force-push, it will be impossible to rebuild the same output in the future.`,
      )
    } else if (refType === 'branch') {
      newAnnotation('failure', 'Dependency is locked with a branch instead of a tag/release.',
                    `${url} is not a deterministic dependency locator.
If the branch advances, it will be impossible to rebuild the same output in the future.`,
      )
    }
  }
}
