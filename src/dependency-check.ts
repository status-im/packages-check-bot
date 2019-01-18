import { Context } from 'probot/lib/context'

export function getDependenciesFromJSON (dependenciesJSON: any): Dependency[] {
  const dependencies: Dependency[] = []

  for (const name in dependenciesJSON) {
    if (dependenciesJSON.hasOwnProperty(name)) {
      dependencies.push(new Dependency(name, dependenciesJSON[name]))
    }
  }

  return dependencies
}

export async function checkDependenciesAsync (context: Context, contents: string, dependencies: Dependency[], filename: string, result: AnalysisResult) {
  if (!dependencies || dependencies.length === 0) {
    return
  }

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
    const { line } = findLineColumn(contents, contents.indexOf(url))
    const optimalAddress = address.endsWith('.git') ? address : address.concat('.git')
    const refType = await getRefTypeAsync(context, address, tag)
    const optimalTag = refType === 'tag' ? tag : '#<release-tag>'
    const suggestedUrl = `${requiredProtocol}${optimalAddress}${optimalTag}`

    const annotationSource: annotationSource = {
      dependency: dependency,
      filename: filename,
      line: line
    }
    if (protocol !== requiredProtocol) {
      result.annotations.push(createAnnotation(annotationSource, suggestedUrl, 'warning',
        `Found protocol ${protocol} being used in dependency`,
        `Protocol should be ${requiredProtocol}.`))
    }
    if (protocol !== 'github:' && !address.endsWith('.git')) {
      result.annotations.push(createAnnotation(annotationSource, suggestedUrl, 'warning',
        'Address should end with .git for consistency.',
        'Android builds have been known to fail when dependency addresses don\'t end with .git.'
      ))
    }
    if (!tag) {
      result.annotations.push(createAnnotation(annotationSource, suggestedUrl, 'failure',
        'Dependency is not locked with a tag/release.',
        `${url} is not a deterministic dependency locator.\r\nIf the branch advances, it will be impossible to rebuild the same output in the future.`
      ))
    } else if (refType === 'unknown') {
      result.annotations.push(createAnnotation(annotationSource, suggestedUrl, 'failure',
        `Dependency is locked with an unknown ref-spec (\`${tag}\`).`,
        `Please check that the tag \`${tag}\` exists in the target repository ${address}.`
      ))
    } else if (refType !== 'tag') {
      result.annotations.push(createAnnotation(annotationSource, suggestedUrl, 'failure',
        'Dependency is locked with a branch, instead of a tag/release.',
        `${url} is not a deterministic dependency locator.\r\nIf the branch advances, it will be impossible to rebuild the same output in the future.`
      ))
    }
  }
}

export class AnnotationResult {
  title?: string
  message: string
  annotationLevel: 'notice' | 'warning' | 'failure'
  dependency: Dependency
  path: string
  startLine: number
  endLine: number
  rawDetails?: string

  constructor (title: string,
               message: string,
               annotationLevel: "notice" | "warning" | "failure",
               dependency: Dependency,
               path: string,
               startLine: number,
               endLine: number,
               rawDetails: string) {
    this.title = title
    this.message = message
    this.annotationLevel = annotationLevel
    this.dependency = dependency
    this.path = path
    this.startLine = startLine
    this.endLine = endLine
    this.rawDetails = rawDetails
  }
}

export class AnalysisResult {
  checkedDependencyCount!: number
  packageJsonFilenames: string[] = []
  annotations!: AnnotationResult[]

  constructor () {
    this.checkedDependencyCount = 0
    this.annotations = []
  }

  addPackageJSONFilename (packageFilename: string) {
    this.packageJsonFilenames.push(packageFilename)
  }
}

export class Dependency {
  name!: string
  url!: string

  constructor (name: string, url: string) {
    this.name = name
    this.url = url
  }
}

type annotationSource = {
  dependency: Dependency
  filename: string
  line: number
}

function findLineColumn (contents: string, index: number) {
  const lines = contents.split('\n')
  const line = contents.substr(0, index).split('\n').length

  const startOfLineIndex = (() => {
    const x = lines.slice(0)
    x.splice(line - 1)
    return x.join('\n').length + (x.length > 0 ? 1 : 0)
  })()

  const col = index - startOfLineIndex

  return { line, col }
}

function createAnnotation (
  annotationSource: annotationSource,
  suggestedUrl: string,
  annotationLevel: "notice" | "warning" | "failure",
  title: string,
  message: string): AnnotationResult {
  const { dependency, filename, line } = annotationSource

  return new AnnotationResult(
    title,
    message.concat(`\r\n\r\nSuggested URL: ${suggestedUrl}`),
    annotationLevel,
    dependency,
    filename,
    line,
    line,
    `{suggestedUrl: ${suggestedUrl}}`
  )
}

async function getRefTypeAsync (context: Context, address: string, tag: string): Promise<'tag' | 'branch' | 'unknown'> {
  if (!tag) {
    return 'branch'
  }

  // 'github.com/status-im/bignumber.js'
  const parts = address.split('/')
  if (parts[0] === 'github.com') {
    // check optimistic case, and see if it is a tag
    try {
      const getRefResponse = await context.github.gitdata.getRef({ owner: parts[1], repo: parts[2].replace('.git', ''), ref: `tags/${tag}` })
      if (getRefResponse.status === 200) {
        return 'tag'
      }
    } catch (error) {
      context.log.trace(error)
    }

    // check if it is a branch
    try {
      const getRefResponse = await context.github.gitdata.getRef({ owner: parts[1], repo: parts[2].replace('.git', ''), ref: `heads/${tag}` })
      if (getRefResponse.status === 200) {
        return 'branch'
      }
    } catch (error) {
      context.log.trace(error)
    }

    // probably not existing?
    return 'unknown'
  }

  // Educated guess
  return 'branch'
}
