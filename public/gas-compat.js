/*******************************************************
 * gas-compat.js
 * จำลอง google.script.run ของ GAS ให้ทำงานผ่าน REST API (/api/rpc) แทน
 * ทำให้โค้ดเดิมที่เขียนแบบ:
 *   google.script.run.withSuccessHandler(cb).withFailureHandler(err).getMasterItems()
 * ใช้งานได้เหมือนเดิมทุกจุด โดยไม่ต้องแก้ไข call site ที่มีอยู่แล้วนับร้อยจุด
 *******************************************************/
(function () {
  function callRpc(fnName, args) {
    return fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: fnName, args: args })
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok || body.error) {
          throw new Error(body.error || 'เกิดข้อผิดพลาดในการเชื่อมต่อ');
        }
        return body.result;
      });
    });
  }

  function makeRunner(successHandler, failureHandler) {
    // proxy: การเรียก .someFunctionName(args) จะถูกดักด้วย Proxy แล้วยิงไปที่ callRpc
    return new Proxy({}, {
      get: function (_target, propName) {
        if (propName === 'withSuccessHandler') {
          return function (cb) { return makeRunner(cb, failureHandler); };
        }
        if (propName === 'withFailureHandler') {
          return function (cb) { return makeRunner(successHandler, cb); };
        }
        if (propName === 'withUserObject') {
          return function () { return makeRunner(successHandler, failureHandler); };
        }
        // มิฉะนั้นถือว่าเป็นชื่อฟังก์ชัน backend ที่ต้องการเรียก
        return function () {
          var args = Array.prototype.slice.call(arguments);
          callRpc(propName, args)
            .then(function (result) { if (successHandler) successHandler(result); })
            .catch(function (err) { if (failureHandler) failureHandler(err); else console.error(err); });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner(null, null);
})();
