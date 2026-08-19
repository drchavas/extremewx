# Deprecated

Superseded pages, kept so old links and bookmarks keep working.

| file | replaced by | why |
|---|---|---|
| `scstrend_map.html` | `../scstrend.html` | one map showing one field at a time; the replacement shows climatology and trend side by side on a shared view |
| `scscard.html` | `../scstrend_grid.html` | fixed 2° card; the replacement puts the same 2° boxes on a pannable linked map |

Both still work. They read their data from `../data/` and `../geo/`, so they
break if moved again without rewriting those paths. The `noindex` headers in
`../.htaccess` are inherited here, so nothing in this folder is indexed.

`test_dom.js` and `test_logic.js` both cover `scstrend_map.html`. Run them from
inside this folder:

    node test_dom.js .
    node test_logic.js scstrend_map.html ../geo/counties.topo.json.gz ../data/hail.json.gz
