" cyclops.vim -- trace a JS/TypeScript program and inspect it without leaving vim
"
" Commands:
"   :CyclopsTrace [target]   trace and open the viewer
"   :CyclopsSummary          show the summary of the last trace in the quickfix window
"   :CyclopsTree             show the last trace as an indented tree
"   :CyclopsFocus <name>     show the subtree of one function
"   :CyclopsOpen             open out/tree.json
"   :CyclopsStop             stop a background trace
"
" Settings:
"   g:cyclops_bin            path to the cyclops binary (default: "cyclops")
"   g:cyclops_port           viewer port (default: 4600)
"
" The point of the editor integration is not the picture -- the browser does
" that better. It is keeping the trace *in the buffer workflow*: no alt-tab, no
" waiting for a page to load, and the summary lands somewhere you can jump from.

if exists('g:loaded_cyclops')
  finish
endif
let g:loaded_cyclops = 1

if !exists('g:cyclops_bin')
  let g:cyclops_bin = 'cyclops'
endif
if !exists('g:cyclops_port')
  let g:cyclops_port = 4600
endif

let s:has_bang = has('nvim') ? 0 : 1

" The target: an argument, or the current file, or the file the buffer came from.
function! s:Target(arg) abort
  if !empty(a:arg)
    return a:arg
  endif
  let l:file = expand('%:p')
  if empty(l:file)
    return '.'
  endif
  return l:file
endfunction

" Run cyclops and capture stdout+stderr. Returns a list [exitcode, output].
function! s:Run(args) abort
  let l:cmd = g:cyclops_bin . ' ' . a:args . ' --no-server --no-open'
  let l:out = systemlist(l:cmd)
  return [v:shell_error, join(l:out, "\n")]
endfunction

function! s:Quickfix(title, lines) abort
  call setqflist([], ' ', {'title': a:title, 'lines': a:lines})
  copen
  setlocal modifiable
  setlocal nowrap
  nnoremap <buffer> q :q<CR>
endfunction

" :CyclopsTrace [target] -- trace, then open the viewer
function! CyclopsTrace(...) abort
  let l:target = s:Target(a:0 ? a:1 : '')
  echo '[cyclops] tracing ' . l:target . ' ...'
  let [l:code, l:out] = s:Run(escape(l:target, ' |*?"\') . ' --port ' . g:cyclops_port)
  if l:code != 0
    echohl ErrorMsg
    echo '[cyclops] failed:'
    echohl None
    for l:line in split(l:out, "\n")
      echom l:line
    endfor
    return
  endif
  execute '!xdg-open http://localhost:' . g:cyclops_port . ' >/dev/null 2>&1 &'
  echo '[cyclops] viewer at http://localhost:' . g:cyclops_port
endfunction

" :CyclopsSummary -- summarize the trace already on disk
"
" Reads out/tree.json rather than re-running: after `:CyclopsTrace` the tree is
" there, and re-running a program with side effects to produce the same tree is
" not a thing a keybinding should do quietly.
function! CyclopsSummary() abort
  let l:tree = s:LoadTree()
  if empty(l:tree)
    echohl ErrorMsg | echo '[cyclops] no trace; run :CyclopsTrace first' | echohl None
    return
  endif
  let l:root = get(l:tree, 'roots', [])
  let l:lines = []
  call add(l:lines, printf('%d frames, %d roots',
        \ len(s:Flatten(l:root)), len(l:root)))
  let l:agg = s:Aggregate(l:root)
  call sort(l:agg, {a, b -> a.total - b.total})
  call add(l:lines, '')
  call add(l:lines, printf('%-8s %-24s %s', 'total', 'name', 'calls'))
  for l:row in l:agg
    call add(l:lines, printf('%-8s %-24s %d', l:row.total . 'ms', l:row.name, l:row.count))
  endfor
  call s:Quickfix('cyclops', l:lines)
endfunction

" :CyclopsTree -- the last trace as an indented tree
function! CyclopsTree() abort
  let l:tree = s:LoadTree()
  if empty(l:tree)
    echohl ErrorMsg | echo '[cyclops] no trace; run :CyclopsTrace first' | echohl None
    return
  endif
  let l:lines = s:Render(s:Flatten(get(l:tree, 'roots', [])))
  call s:Quickfix('cyclops tree', l:lines)
endfunction

" :CyclopsFocus <name> -- the subtree of one function
function! CyclopsFocus(name) abort
  let l:tree = s:LoadTree()
  if empty(l:tree)
    echohl ErrorMsg | echo '[cyclops] no trace; run :CyclopsTrace first' | echohl None
    return
  endif
  let l:needle = tolower(a:name)
  let l:lines = []
  for l:frame in s:Flatten(get(l:tree, 'roots', []))
    if tolower(l:frame.name) =~ l:needle
      call extend(l:lines, s:Render([l:frame]))
    endif
  endfor
  if empty(l:lines)
    echohl WarningMsg | echo '[cyclops] no frame matching ' . a:name | echohl None
    return
  endif
  call s:Quickfix('cyclops: ' . a:name, l:lines)
endfunction

function! CyclopsOpen() abort
  execute '!xdg-open http://localhost:' . g:cyclops_port . ' >/dev/null 2>&1 &'
endfunction

" ---- helpers ---------------------------------------------------------------

function! s:LoadTree() abort
  let l:path = expand('%:p:h') . '/out/tree.json'
  if !filereadable(l:path)
    let l:path = getcwd() . '/out/tree.json'
  endif
  if !filereadable(l:path)
    return {}
  endif
  try
    return json_decode(join(readfile(l:path), ''))
  catch
    return {}
  endtry
endfunction

" Depth-first list of {name, depth, dur}. A flat list rather than a tree
" because every renderer below only ever walks it once.
function! s:Flatten(frames) abort
  let l:out = []
  let l:queue = copy(a:frames)
  let l:depth = 0
  while !empty(l:queue)
    let l:batch = []
    let l:next = []
    for l:frame in l:queue
      call add(l:batch, {'name': l:frame.name, 'depth': l:depth,
            \ 'dur': get(l:frame, 'duration', -1),
            \ 'frame': l:frame})
      call extend(l:next, get(l:frame, 'children', []))
    endfor
    call extend(l:out, l:batch)
    let l:queue = l:next
    let l:depth += 1
  endwhile
  return l:out
endfunction

function! s:Aggregate(frames) abort
  let l:rows = {}
  for l:item in s:Flatten(a:frames)
    let l:name = l:item.name
    if !has_key(l:rows, l:name)
      let l:rows[l:name] = {'name': l:name, 'count': 0, 'total': 0}
    endif
    let l:rows[l:name].count += 1
    let l:rows[l:name].total += max([l:item.dur, 0])
  endfor
  return values(l:rows)
endfunction

function! s:Render(items) abort
  let l:lines = []
  for l:item in a:items
    let l:prefix = repeat('  ', l:item.depth)
    let l:duration = l:item.dur >= 0 ? printf('%6dms', l:item.dur) : '      -'
    call add(l:lines, printf('%s%-28s %s', l:prefix, l:item.name, l:duration))
  endfor
  return l:lines
endfunction

command! -nargs=? CyclopsTrace :call CyclopsTrace(<f-args>)
command! CyclopsSummary :call CyclopsSummary()
command! CyclopsTree :call CyclopsTree()
command! -nargs=1 CyclopsFocus :call CyclopsFocus(<q-args>)
command! CyclopsOpen :call CyclopsOpen()