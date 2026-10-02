import type { Exec } from '../../src/types.ts'

// parse the `security -i` stdin command barrito writes:
//   add-generic-password -U -s "<svc>" -a "<acct>" -T /usr/bin/security -w "<value>"
const unquote = (s: string): string => s.slice(1, -1).replace(/\\(["\\])/g, '$1')

export const parseSecurityI = (input: string): { service: string; account: string; value: string; trusted: boolean } => {
  const m = String(input).match(/^add-generic-password -U -s ("(?:[^"\\]|\\.)*") -a ("(?:[^"\\]|\\.)*") -T \/usr\/bin\/security -w ("(?:[^"\\]|\\.)*")\n$/)
  if (!m) throw new Error(`unparseable security -i input: ${JSON.stringify(input)}`)
  return { service: unquote(m[1] ?? ''), account: unquote(m[2] ?? ''), value: unquote(m[3] ?? ''), trusted: true }
}

type Call = { bin: string; args: string[]; input?: string }

// fake /usr/bin/security: `-i` stores the parsed value, find-generic-password returns it,
// delete-generic-password drops it, dump-keychain lists names (attributes only, like the real one)
export const fakeSecurity = (seed: Record<string, string> = {}, { readBack }: { readBack?: (service: string, stored: string | undefined) => string | undefined } = {}) => {
  const store: Record<string, string> = { ...seed }
  const calls: Call[] = []
  const exec: Exec = (bin, args, opts = {}) => {
    const input = typeof opts.input === 'string' ? opts.input : undefined
    calls.push({ bin, args, input })
    if (args[0] === '-i') {
      const p = parseSecurityI(input ?? '')
      store[p.service] = p.value
      return ''
    }
    if (args[0] === 'find-generic-password') {
      const svc = args[args.indexOf('-s') + 1] ?? ''
      const v = readBack ? readBack(svc, store[svc]) : store[svc]
      if (v === undefined) throw Object.assign(new Error('The specified item could not be found in the keychain.'), { status: 44 })
      return `${v}\n`
    }
    if (args[0] === 'delete-generic-password') {
      const svc = args[args.indexOf('-s') + 1] ?? ''
      if (store[svc] === undefined) throw Object.assign(new Error('The specified item could not be found in the keychain.'), { status: 44 })
      delete store[svc]
      return ''
    }
    if (args[0] === 'dump-keychain') {
      return Object.keys(store).map((svc) => `keychain: "/Users/x/Library/Keychains/login.keychain-db"\nattributes:\n    "acct"<blob>="barrito"\n    "svce"<blob>="${svc}"\n`).join('')
    }
    throw new Error(`unexpected security args: ${args.join(' ')}`)
  }
  return { store, calls, exec }
}
