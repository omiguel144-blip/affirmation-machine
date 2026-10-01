export interface Saved {
  id: string;
  name: string;
  created: number;
  blob: Blob;
}

const db = () =>
  new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open("affirmations", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("items", { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const r = fn(d.transaction("items", mode).objectStore("items"));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export const listSaved = async () =>
  (await tx<Saved[]>("readonly", (s) => s.getAll())).sort((a, b) => b.created - a.created);
export const saveItem = (item: Saved) => tx("readwrite", (s) => s.put(item));
export const deleteItem = (id: string) => tx("readwrite", (s) => s.delete(id));
