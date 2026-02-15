{ lib, couchdb3, couchmail-ui, symlinkJoin, writeTextFile }:

let
  # CouchDB config snippet that registers the UI handler
  couchmailConfig = writeTextFile {
    name = "couchmail-httpd.ini";
    text = ''
      [httpd_global_handlers]
      _couchmail = {couch_httpd_misc_handlers, handle_utils_dir_req, "${couchmail-ui}"}
    '';
  };
in
symlinkJoin {
  name = "couchdb-with-couchmail";
  paths = [ couchdb3 ];
  postBuild = ''
    # Add the couchmail UI config to CouchDB's default.d
    mkdir -p $out/etc/default.d
    cp ${couchmailConfig} $out/etc/default.d/couchmail.ini
  '';

  meta = couchdb3.meta // {
    description = "CouchDB with embedded Couchmail web UI";
  };
}
