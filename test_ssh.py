import paramiko
import sys

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

try:
    client.connect('10.99.208.197', port=8022, username='u0_a123', password='123456', timeout=10)
    stdin, stdout, stderr = client.exec_command('whoami; uname -a; proot-distro list')
    print("STDOUT:")
    print(stdout.read().decode())
    print("STDERR:")
    print(stderr.read().decode())
except Exception as e:
    print(f"Failed: {e}")
finally:
    client.close()
