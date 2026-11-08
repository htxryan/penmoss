import json, os, subprocess, sys, time
P, home = sys.argv[1], sys.argv[2]
env = dict(os.environ, PENMOSS_HOME=home, GIT_CONFIG_GLOBAL='/dev/null')
proc = subprocess.Popen([P, '--penmoss-cli', 'mcp', '--notebook', 'nb'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True, bufsize=1)
def call(i, method, params=None):
    msg = {'jsonrpc': '2.0', 'id': i, 'method': method}
    if params is not None: msg['params'] = params
    t = time.time(); proc.stdin.write(json.dumps(msg) + '\n'); proc.stdin.flush()
    line = proc.stdout.readline(); return json.loads(line), round((time.time() - t) * 1000)
r, ms = call(1, 'initialize', {'protocolVersion': '2025-06-18'}); print('init', ms, 'ms', 'meaning' in r['result']['instructions'])
r, ms = call(2, 'tools/list'); d = [t for t in r['result']['tools'] if t['name'] == 'search_notes'][0]['description']; print('tools', ms, 'ms', d[:90])
time.sleep(int(os.environ.get("WAIT", "8")))
for i, q in enumerate(['keep the computers running during a blackout', 'looking after the bread culture', 'shrines and trains']):
    r, ms = call(10 + i, 'tools/call', {'name': 'search_notes', 'arguments': {'query': q, 'limit': 2}})
    sc = r['result']['structuredContent']; print('search', ms, 'ms', sc['mode'], [(x['title'], x['foundBy']) for x in sc['results']], sc.get('coverage'), sc.get('notice'))
proc.stdin.close(); proc.wait(timeout=60); err = proc.stderr.read(); print('exit', proc.returncode, err.strip()[-400:])
