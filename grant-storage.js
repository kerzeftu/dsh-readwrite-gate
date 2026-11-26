import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

export const GRANT_DOMAIN = 'readwrite_gate_grants'

function parseSnapshot(value) {
  if (value === null || typeof value !== 'object' || value.version !== 1
    || !Array.isArray(value.readAllow) || !Array.isArray(value.grants)) {
    throw new TypeError('Invalid authorization snapshot')
  }
  const isPath = (path) => typeof path === 'string' && isAbsolute(path) && !path.includes('\0')
  if (!value.readAllow.every(isPath)) throw new TypeError('Invalid authorization allowlist')
  const paths = new Set()
  const grants = value.grants.map((row) => {
    if (!isPath(row?.path) || paths.has(row.path)
      || typeof row.read !== 'boolean' || typeof row.write !== 'boolean'
      || typeof row.directory !== 'boolean' || (!row.read && !row.write)) {
      throw new TypeError('Invalid authorization entry')
    }
    paths.add(row.path)
    return { path: row.path, read: row.read, write: row.write, directory: row.directory }
  })
  return { version: 1, readAllow: [...value.readAllow], grants }
}

// DomainFacility accepts a schema parser. Keeping it local avoids resolving
// Zod or any private package from the running Harness installation.
const spec = {
  name: GRANT_DOMAIN,
  version: 1,
  layout: 'per-record',
  tables: { sessions: { valueSchema: { parse: parseSnapshot } } },
}

/**
 * Check the deployment contract without inferring protection from a pathname.
 * `protected-backend` is a host operator's attestation that the routed backend
 * and its configuration are outside every model tool's write authority.
 */
export function selectGrantStorage({ facility, profileDirectory, mode }) {
  if (mode !== 'protected-backend') return { reason: 'unverified-backend' }
  if (typeof facility?.open !== 'function') return { reason: 'missing-storage-service' }
  if (typeof profileDirectory !== 'string' || !isAbsolute(profileDirectory)) {
    return { reason: 'missing-profile-identity' }
  }
  return { store: createGrantStorage({ facility, namespace: profileDirectory }) }
}

/** A lazy table adapter. The host caller must establish backend trust first. */
export function createGrantStorage({ facility, namespace }) {
  if (typeof facility?.open !== 'function' || typeof namespace !== 'string' || namespace === '') {
    throw new TypeError('A protected storage facility and profile namespace are required')
  }
  let opening
  let closed = false
  function keyOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new TypeError('Missing session id')
    return createHash('sha256').update(JSON.stringify([namespace, sessionId])).digest('hex')
  }
  async function table() {
    if (closed) throw new Error('Authorization storage is closed')
    opening ??= Promise.resolve().then(() => facility.open(spec))
    const domain = await opening
    if (closed) throw new Error('Authorization storage is closed')
    return domain.table('sessions')
  }
  return {
    async load(sessionId) {
      const key = keyOf(sessionId)
      const value = (await table()).get(key)
      return value === undefined ? undefined : parseSnapshot(value)
    },
    async save(sessionId, value) {
      const key = keyOf(sessionId)
      const snapshot = parseSnapshot(value)
      await (await table()).put(key, snapshot)
    },
    async close() {
      if (closed) return
      closed = true
      const domain = await opening?.catch(() => undefined)
      if (domain !== undefined) await domain.close()
    },
  }
}
