export type GitRefType = 'commit' | 'tag' | 'branch'

export interface Dependency {
  name: string
  url: string
  rawRefType?: string,
  refType?: GitRefType | undefined
  refName?: string
}
