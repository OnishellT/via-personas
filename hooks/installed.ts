import type { EngineInterface } from 'claude-code'

// Only harnesses installed at session start get an agent type: each description rides on every request.
export async function onPath($: Pick<EngineInterface, 'env' | 'fs'>, bin: string): Promise<boolean> {
  const path = (await $.env.get('PATH')) ?? ''
  const dirs = path.split(path.includes(';') ? ';' : ':').filter(Boolean)
  const found = await Promise.all(
    dirs.flatMap((dir) =>
      [bin, `${bin}.exe`].map((name) =>
        $.fs.stat(`${dir}/${name}`).then(
          (s) => s.kind === 'file',
          () => false,
        ),
      ),
    ),
  )
  return found.includes(true)
}
