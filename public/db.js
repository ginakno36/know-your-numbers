// Know Your Numbers — storage adapter (window.__kynDb)
// Extracted from the original single-file index.html; behaviour unchanged.
  // ---- standalone deployment: db capability shim ----
  // Same doc().get()/.set()/.update() interface the app already uses throughout,
  // just backed by fetch() calls to this app's own REST API instead of the
  // Claude Artifact runtime's built-in storage. Nothing else in this file changes.
  window.__kynDb = function(){
    function req(method, path, body){
      var url = "/api/doc/" + path.split("/").map(encodeURIComponent).join("/");
      var opts = { method: method, headers: {} };
      if(body !== undefined){
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
      }
      return fetch(url, opts).then(function(res){
        if(!res.ok) throw new Error("db request failed: " + res.status);
        return res.json();
      });
    }
    return {
      doc: function(path){
        return {
          get: function(){
            return req("GET", path).then(function(result){
              var frozen = result.exists ? Object.freeze(JSON.parse(JSON.stringify(result.data))) : null;
              return { exists: !!result.exists, data: function(){ return frozen; } };
            });
          },
          set: function(value){ return req("PUT", path, value).then(function(){ return undefined; }); },
          update: function(patch){ return req("PATCH", path, patch).then(function(){ return undefined; }); },
          delete: function(){ return req("DELETE", path).then(function(){ return undefined; }); }
        };
      }
    };
  };
