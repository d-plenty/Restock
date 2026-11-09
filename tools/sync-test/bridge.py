import sys, json, sqlite3
db = sqlite3.connect(sys.argv[1], isolation_level=None)
db.row_factory = sqlite3.Row
for sql in [s for step in json.load(open(sys.argv[2])) for s in step]:
    db.execute(sql)
db.execute("PRAGMA user_version = 99")
out = sys.stdout
for line in sys.stdin:
    m = json.loads(line)
    try:
        cur = db.execute(m.get('sql', 'SELECT 1'), m.get('args', []))
        rows = [dict(r) for r in cur.fetchall()] if m['op'] == 'query' else []
        out.write(json.dumps({'rows': rows}) + '\n')
    except Exception as e:
        out.write(json.dumps({'error': str(e)}) + '\n')
    out.flush()
