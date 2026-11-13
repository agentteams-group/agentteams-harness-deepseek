import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function checkpointInput(session, event, { id, eventId, roomId, workspace, flush }) {
  if (event?.type !== 'user/message' || event.data.id !== id || !eventId || !roomId) return false
  await flush(session)
  const directory = join(workspace, '.agentteams', 'dsh-checkpoints')
  await mkdir(directory, { recursive: true })
  const key = createHash('sha256').update(JSON.stringify([roomId, eventId])).digest('hex')
  const path = join(directory, `${key}.json`)
  await writeFile(`${path}.tmp`, JSON.stringify({ receipts: [{ room_id: roomId, event_id: eventId }] }))
  await rename(`${path}.tmp`, path)
  return true
}
