const increments = Symbol('increment');
export const FieldValue = { increment: amount => ({ [increments]: amount }) };

function encode(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isSafeInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number' && Number.isFinite(value)) return { doubleValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  if (value && typeof value === 'object') return { mapValue: { fields: fields(value) } };
  throw new TypeError('Unsupported Firestore value');
}

function fields(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, encode(item)]));
}

function decode(value) {
  if ('nullValue' in value) return null;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decode);
  if ('mapValue' in value) return readFields(value.mapValue.fields);
  return Object.values(value)[0];
}

function readFields(value = {}) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
}

const operators = { '==': 'EQUAL', '<=': 'LESS_THAN_OR_EQUAL', '<': 'LESS_THAN', '>=': 'GREATER_THAN_OR_EQUAL', '>': 'GREATER_THAN' };
const pauseAfterConflict = attempt => new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt + Math.random() * 75));

function segment(value) {
  if (typeof value !== 'string' || !value || value.includes('/') || value === '.' || value === '..') {
    throw new TypeError('Invalid Firestore path segment');
  }
  return value;
}

function fieldPath(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '\x60' + name.replace(/[\\\x60]/g, '\\$&') + '\x60';
}

function makeWrite(ref, operation, data = {}, merge = false) {
  if (operation === 'delete') return { delete: ref.name };
  const ordinary = Object.entries(data).filter(([, value]) => value !== undefined && value?.[increments] === undefined);
  const transforms = Object.entries(data).filter(([, value]) => value?.[increments] !== undefined)
    .map(([name, value]) => ({ fieldPath: fieldPath(name), increment: encode(value[increments]) }));
  const write = { update: { name: ref.name, fields: fields(Object.fromEntries(ordinary)) } };
  if (operation === 'create') write.currentDocument = { exists: false };
  if (operation === 'update') write.currentDocument = { exists: true };
  if (operation === 'update' || merge) write.updateMask = { fieldPaths: ordinary.map(([name]) => fieldPath(name)) };
  if (transforms.length) write.updateTransforms = transforms;
  return write;
}

export function createFirestore({ projectId, token, fetcher = fetch, emulator }) {
  if (!/^[a-z][a-z0-9-]+$/.test(projectId)) throw new Error('Invalid Firestore project');
  const root = `projects/${projectId}/databases/(default)`;
  const documents = `${root}/documents`;
  const base = emulator || 'https://firestore.googleapis.com';

  async function request(path, body) {
    const response = await fetcher(`${base}/v1/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const error = new Error('Firestore request failed');
      error.status = payload.error?.status ?? String(response.status);
      throw error;
    }
    return response.json();
  }

  function document(path) {
    const name = `${documents}/${path}`;
    const id = path.split('/').at(-1);
    const write = (operation, data, options) => request(`${documents}:commit`, {
      writes: [makeWrite(ref, operation, data, options?.merge)]
    });
    const ref = {
      name, id, collection: id => query(`${path}/${segment(id)}`),
      get: async () => (await getMany([ref]))[0],
      create: data => write('create', data),
      set: (data, options) => write('set', data, options),
      update: data => write('update', data),
      delete: () => write('delete')
    };
    return ref;
  }

  function snapshot(ref, value) {
    return { ref, id: ref.id, exists: !!value, data: () => value && readFields(value.fields),
      updateTime: { value: value?.updateTime, isEqual(other) { return this.value === other?.value; } } };
  }

  async function getMany(refs, transaction) {
    if (!refs.length) return [];
    const rows = await request(`${documents}:batchGet`, {
      documents: [...new Set(refs.map(ref => ref.name))], ...(transaction && { transaction })
    });
    const results = new Map(rows.map(row => [row.found?.name ?? row.missing, row]));
    return refs.map(ref => {
      const row = results.get(ref.name);
      if (!row) throw new Error('Incomplete Firestore response');
      return snapshot(ref, row.found);
    });
  }

  function query(path, spec = {}) {
    const parts = path.split('/');
    const collectionId = parts.pop();
    const parent = [documents, ...parts].join('/');
    const clone = next => query(path, { ...spec, ...next });
    const filters = spec.filters ?? [];
    return {
      doc: id => document(`${path}/${segment(id)}`),
      where(field, operation, value) {
        if (!Object.hasOwn(operators, operation)) throw new TypeError('Unsupported Firestore query operator');
        return clone({ filters: [...filters, { fieldFilter: {
          field: { fieldPath: field }, op: operators[operation], value: encode(value)
        } }] });
      },
      orderBy: (field, direction) => clone({ orderBy: [{ field: { fieldPath: field }, direction: direction === 'desc' ? 'DESCENDING' : 'ASCENDING' }] }),
      limit: limit => clone({ limit }),
      startAfter: ref => clone({ startAt: { values: [{ referenceValue: ref.name }], before: false } }),
      async get(transaction) {
        const where = filters.length > 1 ? { compositeFilter: { op: 'AND', filters } } : filters[0];
        const result = await request(`${parent}:runQuery`, { structuredQuery: {
          from: [{ collectionId }], where, orderBy: spec.orderBy, limit: spec.limit, startAt: spec.startAt
        }, ...(transaction && { transaction }) });
        const docs = result.flatMap(row => row.document ? [
          snapshot(document(row.document.name.slice(documents.length + 1)), row.document)
        ] : []);
        return { docs, empty: docs.length === 0, size: docs.length };
      }
    };
  }

  function batch() {
    const writes = [];
    const writer = {
      writes,
      create: (ref, data) => writes.push(makeWrite(ref, 'create', data)),
      set: (ref, data, options) => writes.push(makeWrite(ref, 'set', data, options?.merge)),
      update: (ref, data) => writes.push(makeWrite(ref, 'update', data)),
      delete: ref => writes.push(makeWrite(ref, 'delete')),
      commit: () => request(`${documents}:commit`, { writes })
    };
    return writer;
  }

  return {
    doc: document, collection: query, batch, getAll: (...refs) => getMany(refs),
    async runCheckout(refs, action) {
      // Check versions at atomic commit instead of upgrading shared read locks.
      for (let attempt = 0; attempt < 4; attempt++) {
        const snapshots = new Map((await getMany(refs)).map(snapshot => [snapshot.ref.name, snapshot]));
        const writer = batch();
        const get = async ref => {
          const snapshot = snapshots.get(ref.name);
          if (!snapshot || writer.writes.length) throw new Error('Invalid checkout read');
          return snapshot;
        };
        const result = await action({ ...writer, get });
        if (!writer.writes.length) return result;
        const written = new Set();
        for (const write of writer.writes) {
          const name = write.update?.name;
          const snapshot = snapshots.get(name);
          if (snapshot) {
            write.currentDocument = snapshot.exists ? { updateTime: snapshot.updateTime.value } : { exists: false };
            written.add(name);
          }
        }
        for (const [name, snapshot] of snapshots) {
          if (!written.has(name)) writer.writes.push({
            verify: name, currentDocument: snapshot.exists ? { updateTime: snapshot.updateTime.value } : { exists: false }
          });
        }
        try {
          await writer.commit();
          return result;
        } catch (error) {
          if (!['ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(error.status)) throw error;
          console.info('Bazaar checkout conflict', error.status, attempt + 1);
          if (attempt === 3) {
            console.warn('Bazaar checkout contention exhausted', error.status, attempt + 1);
            throw Object.assign(new Error('Checkout contention'), { status: 'CHECKOUT_CONTENTION' });
          }
          // Spread clients that all read the same popular product version.
          await new Promise(resolve => setTimeout(resolve, 25 + Math.random() * 250 * 2 ** attempt));
        }
      }
    },
    async runTransaction(action, { readOnly = false } = {}) {
      for (let attempt = 0; attempt < 4; attempt++) {
        let transaction;
        try {
          ({ transaction } = await request(`${documents}:beginTransaction`, {
            options: readOnly ? { readOnly: {} } : { readWrite: {} }
          }));
          const writer = batch();
          let pending = [];
          const get = ref => {
            if (writer.writes.length) throw new Error('Transaction reads must precede writes');
            if (!ref.name) return ref.get(transaction);
            return new Promise((resolve, reject) => {
              pending.push({ ref, resolve, reject });
              if (pending.length !== 1) return;
              queueMicrotask(async () => {
                const current = pending;
                pending = [];
                try {
                  const results = await getMany(current.map(item => item.ref), transaction);
                  current.forEach((item, index) => item.resolve(results[index]));
                } catch (error) {
                  current.forEach(item => item.reject(error));
                }
              });
            });
          };
          const result = await action({ ...writer, get });
          await request(readOnly ? `${documents}:rollback` : `${documents}:commit`,
            readOnly ? { transaction } : { transaction, writes: writer.writes });
          return result;
        } catch (error) {
          if (error.status === 'ABORTED' && !readOnly && attempt < 3) {
            if (transaction) await request(`${documents}:rollback`, { transaction }).catch(() => {});
            await pauseAfterConflict(attempt);
            continue;
          }
          if (transaction) await request(`${documents}:rollback`, { transaction }).catch(() => {});
          throw error;
        }
      }
    }
  };
}
