export interface Dependency {
  name: string
  url: string
  rawRefType?: string,
  refType?: 'commit' | 'tag' | 'branch' | 'unknown'
  refName?: string
}
