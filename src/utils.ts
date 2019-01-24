import Octokit from '@octokit/rest'
import { Context } from 'probot'

import { GitRefType } from './dependency'

export function findLineInFileContent(contents: string, substring: string): number {
  const index = contents.indexOf(substring)
  if (index < 0) {
    return -1
  }

  const line = contents.substr(0, index).split('\n').length

  // const lines = contents.split('\n')
  // const startOfLineIndex = (() => {
  //   const x = lines.slice(0)
  //   x.splice(line - 1)
  //   return x.join('\n').length + (x.length > 0 ? 1 : 0)
  // })()

  // const col = index - startOfLineIndex

  return line
}

export async function slowGetRefTypeAsync(
  context: Context,
  address: string,
  tag: string,
): Promise<GitRefType | undefined> {
  if (!tag) {
    return 'branch'
  }

  // e.g. 'github.com/status-im/bignumber.js'
  const parts = address.split('/')
  if (parts[0] === 'github.com') {
    const params: Octokit.GitdataGetRefParams = {
      owner: parts[1],
      repo: parts[2].endsWith('.git') ? parts[2].substring(0, parts[2].length - 4) : parts[2],

      ref: '',
    }

    // check optimistic case, and see if it is a tag
    try {
      await context.github.gitdata.getRef({ ...params, ref: `tags/${tag}` })
      return 'tag'
    } catch (error) {
      context.log.trace(error)
    }

    // check if it is a branch
    try {
      await context.github.gitdata.getRef({ ...params, ref: `heads/${tag}` })
      return 'branch'
    } catch (error) {
      context.log.trace(error)
    }

    // check if it is a commit
    try {
      await context.github.gitdata.getCommit({ ...params, commit_sha: tag })
      return 'commit'
    } catch (error) {
      context.log.trace(error)
    }

    // probably not existing?
    return undefined
  }

  // Educated guess
  return 'branch'
}
