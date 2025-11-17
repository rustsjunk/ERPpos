import os
import subprocess
import sys
from pos_server import app

def start_receipt_agent():
    if os.getenv('RECEIPT_AGENT_AUTO_START', '0') != '1':
        return None
    if os.environ.get('WERKZEUG_RUN_MAIN') == 'true':
        return None
    script_path = os.path.join(os.path.dirname(__file__), 'receipt_agent.py')
    if not os.path.exists(script_path):
        return None
    env = os.environ.copy()
    env.setdefault('RECEIPT_AGENT_HOST', '127.0.0.1')
    env.setdefault('RECEIPT_AGENT_PORT', '5001')
    return subprocess.Popen([sys.executable, script_path], env=env)


if __name__ == '__main__':
    debug = os.getenv('FLASK_DEBUG', '0') == '1'
    port = int(os.getenv('PORT', '5000'))
    host = os.getenv('HOST', '0.0.0.0')
    agent_proc = start_receipt_agent()
    try:
        app.run(host=host, port=port, debug=debug)
    finally:
        if agent_proc:
            agent_proc.terminate()
