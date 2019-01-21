export interface Dependency {
  name: string
  url: string
  refType?: 'commit' | 'tag' | 'branch' | 'unknown'
}
