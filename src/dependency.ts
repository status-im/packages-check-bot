export interface Dependency {
  name: string
  url: string
  refType?: 'tag' | 'branch' | 'unknown'
}
