/** เทียบเท่า LockService.getScriptLock() ของ GAS แบบง่าย: serialize การเขียนชีทกันข้อมูลชนกัน */
class Mutex {
  constructor() { this._locked = false; this._queue = []; }
  lock() {
    return new Promise(resolve => {
      if (!this._locked) { this._locked = true; resolve(); }
      else this._queue.push(resolve);
    });
  }
  unlock() {
    if (this._queue.length) { const next = this._queue.shift(); next(); }
    else this._locked = false;
  }
  async runExclusive(fn) {
    await this.lock();
    try { return await fn(); }
    finally { this.unlock(); }
  }
}

module.exports = new Mutex();
