import { AnnotationResult } from './annotation-result'

export class AnalysisResult {
  public checkedDependencyCount!: number
  public packageJsonFilenames: string[] = []
  public annotations!: AnnotationResult[]

  constructor() {
    this.checkedDependencyCount = 0
    this.annotations = []
  }

  public addPackageJSONFilename(packageFilename: string) {
    this.packageJsonFilenames.push(packageFilename)
  }
}
