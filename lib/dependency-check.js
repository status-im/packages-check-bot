module.exports = checkDependencies

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
  