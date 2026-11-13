#!/usr/bin/env python3
"""independent raw-JSONL check of API history costs across local and SSH hosts.

python3 scripts/recount-claude.py /tmp/history.json laptop root@host
Uses the Python oracle's pricing, never tally's SQLite index or TS parser.
Remote hosts need only Python 3. Output contains totals, never message bodies.
"""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True

# one last JSONL line per message id, including subagent files
COLLECT = r'''
import os,json,glob,datetime
rows={}
for path in glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'),recursive=True):
 if os.stat(path).st_mtime < START: continue
 for line in open(path,errors='replace'):
  if '"assistant"' not in line: continue
  try:
   row=json.loads(line); message=row.get('message') or {}
   mid=message.get('id'); usage=message.get('usage'); stamp=row.get('timestamp')
   if row.get('type')!='assistant' or not mid or not usage or not stamp: continue
   t=datetime.datetime.fromisoformat(stamp.replace('Z','+00:00')).timestamp()
   if t<START: continue
   record={'mid':mid,'t':t,'model':message.get('model','?'),'usage':usage}
   # final line wins within each file; identical ids in forks count once too
   rows[mid]=record
  except (ValueError,TypeError): continue
print(json.dumps(list(rows.values())))
'''


def main():
    history = json.loads(Path(sys.argv[1]).read_text())
    weeks = history['weeks'][-2:]
    start = min(week['from'] for week in weeks)
    spec = importlib.util.spec_from_file_location('oracle', Path(__file__).parent / 'oracle/extract.py')
    oracle = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(oracle)
    requests = {}
    for host in ['local', *sys.argv[2:]]:
        command = [sys.executable, '-'] if host == 'local' else ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'python3', '-']
        raw = subprocess.run(command, input=f'START={start}\n' + COLLECT, text=True, capture_output=True, check=True, timeout=180)
        for row in json.loads(raw.stdout):
            requests[row['mid']] = row
    for week in weeks:
        rows = [row for row in requests.values() if week['from'] <= row['t'] < week['to']]
        total = 0
        for row in rows:
            u = row['usage']
            cw = u.get('cache_creation')
            total += oracle.request_cost(row['model'], u.get('input_tokens', 0), (cw or {}).get('ephemeral_1h_input_tokens', 0),
                                         cw.get('ephemeral_5m_input_tokens', 0) if cw is not None else u.get('cache_creation_input_tokens', 0),
                                         u.get('cache_read_input_tokens', 0), u.get('output_tokens', 0))
        print(json.dumps({'resetsAt': week['resetsAt'], 'from': week['from'], 'to': week['to'], 'requests': len(rows),
                          'recountCost': total, 'apiCost': week['usage']['cost'], 'difference': total - week['usage']['cost']}))


if __name__ == '__main__':
    main()
