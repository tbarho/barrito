import fs from 'node:fs'
import path from 'node:path'
import { paths } from './paths.ts'
import type { Log } from './types.ts'

// size-based rotation: file → file.1 → … → file.<keep>; never throws
export const create = ({ file = paths.logs, maxBytes = 5e6, keep = 3 }: { file?: string; maxBytes?: number; keep?: number } = {}): Log => {
  const shift = () => {
    try { fs.rmSync(`${file}.${keep}`, { force: true }) } catch {}
    for (let i = keep - 1; i > 0; i--) {
      try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`) } catch {}
    }
    try { fs.renameSync(file, `${file}.1`) } catch {}
  }

  const log = (line: string) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      let size = 0
      try { size = fs.statSync(file).size } catch {}
      if (size && size + line.length + 1 > maxBytes) shift()
      fs.appendFileSync(file, `${line}\n`)
    } catch {}
  }

  return log
}
