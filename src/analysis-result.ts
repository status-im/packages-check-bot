import { AnnotationResult } from './annotation-result'

export class AnalysisResult {
  public checkedDependencyCount!: number
  public sourceFilenames: string[] = []
  public annotations!: AnnotationResult[]

  constructor() {
    this.checkedDependencyCount = 0
    this.annotations = []
  }

  public addPackageFilename(packageFilename: string) {
    this.sourceFilenames.push(packageFilename)
  }
}
