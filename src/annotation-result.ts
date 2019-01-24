import { AnnotationSource } from './annotation-source'
import { Dependency } from './dependency'

export class AnnotationResult {
  public title?: string
  public message: string
  public annotationLevel: 'notice' | 'warning' | 'failure'
  public dependency: Dependency
  public path: string
  public startLine: number
  public endLine: number
  public rawDetails?: string

  constructor(
    title: string,
    message: string,
    annotationLevel: 'notice' | 'warning' | 'failure',
    dependency: Dependency,
    path: string,
    startLine: number,
    endLine: number,
    rawDetails?: string,
  ) {
    this.title = title
    this.message = message
    this.annotationLevel = annotationLevel
    this.dependency = dependency
    this.path = path
    this.startLine = startLine
    this.endLine = endLine
  }
}

export function createAnnotation(
  annotationSource: AnnotationSource,
  annotationLevel: 'notice' | 'warning' | 'failure',
  title: string,
  message: string,
): AnnotationResult {
  const { dependency, filename, line } = annotationSource

  return new AnnotationResult(
    title,
    message,
    annotationLevel,
    dependency,
    filename,
    line,
    line,
  )
}
