import { Dependency } from './dependency'

export interface AnnotationSource {
  dependency: Dependency
  filename: string
  line: number
}
