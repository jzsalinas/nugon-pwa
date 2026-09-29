const fs = require('fs/promises');
const path = require('path');

const EMPTY_STATE = Object.freeze({
  schemaVersion: 1,
  devices: [],
  links: [],
  pairings: [],
  rateLimits: []
});

function newState() {
  return JSON.parse(JSON.stringify(EMPTY_STATE));
}

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      await fs.access(this.filePath);
      await fs.chmod(this.filePath, 0o600);
      await this.read();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.atomicWrite(newState());
    }
  }

  async read() {
    await this.queue;
    const raw = await fs.readFile(this.filePath, 'utf8');
    const state = JSON.parse(raw);
    this.validateState(state);
    return structuredClone(state);
  }

  update(mutator) {
    const operation = this.queue.then(async () => {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const state = JSON.parse(raw);
      this.validateState(state);
      const result = await mutator(state);
      await this.atomicWrite(state);
      return result;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async atomicWrite(state) {
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await fs.writeFile(tempPath, serialized, { mode: 0o600, flag: 'wx' });
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, this.filePath);
  }

  validateState(state) {
    if (!state || state.schemaVersion !== 1
        || !Array.isArray(state.devices)
        || !Array.isArray(state.links)
        || !Array.isArray(state.pairings)
        || !Array.isArray(state.rateLimits)) {
      throw new Error('Invalid state-v1.json structure');
    }
  }
}

module.exports = { JsonStore, newState };
