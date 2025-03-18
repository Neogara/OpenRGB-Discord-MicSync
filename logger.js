function log(prefix, message) {
    console.log(`[${prefix}] ${message}`);
  }
  
  function error(prefix, message) {
    console.error(`[${prefix} ERROR] ${message}`);
  }
  
  module.exports = { log, error };