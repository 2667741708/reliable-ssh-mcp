import { Buffer } from "node:buffer";

const REMOTE_RUNNER = String.raw`
import base64
import concurrent.futures
import getpass
import hashlib
import ipaddress
import json
import os
import pathlib
import platform
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import tarfile
import time
import traceback
import zipfile

PAYLOAD = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.flush()

def read_limited(handle, limit):
    handle.flush()
    handle.seek(0, os.SEEK_END)
    size = handle.tell()
    handle.seek(0)
    data = handle.read(limit)
    return {
        "data_b64": base64.b64encode(data).decode("ascii"),
        "size_bytes": size,
        "truncated": size > limit,
    }

def run_process(payload):
    program = payload["program"]
    arguments = payload.get("args", [])
    command = [program] + arguments
    environment = os.environ.copy()
    environment.update(payload.get("env", {}))
    environment.setdefault("PYTHONIOENCODING", "utf-8")
    environment.setdefault("PYTHONUTF8", "1")
    stdin_data = base64.b64decode(payload.get("stdin_b64", ""))
    timeout_seconds = payload["timeout_seconds"]
    output_limit = payload["max_output_bytes"]
    started = time.monotonic()
    timed_out = False

    with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
        process = subprocess.Popen(
            command,
            cwd=payload.get("cwd") or None,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=stdout_file,
            stderr=stderr_file,
            start_new_session=True,
        )
        try:
            process.communicate(input=stdin_data, timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            if hasattr(os, "killpg"):
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
            process.wait()

        duration_ms = round((time.monotonic() - started) * 1000)
        return {
            "exit_code": process.returncode,
            "timed_out": timed_out,
            "duration_ms": duration_ms,
            "stdout": read_limited(stdout_file, output_limit),
            "stderr": read_limited(stderr_file, output_limit),
        }

def parse_os_release():
    values = {}
    try:
        with open("/etc/os-release", "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.rstrip("\n")
                if "=" not in line:
                    continue
                key, value = line.split("=", 1)
                values[key] = value.strip().strip('"')
    except OSError:
        pass
    return values

TEXT_SUFFIXES = {
    ".bat", ".bash", ".cfg", ".cmd", ".conf", ".csv", ".css", ".env",
    ".html", ".ini", ".java", ".js", ".json", ".jsx", ".md", ".mjs",
    ".php", ".pl", ".ps1", ".psd1", ".psm1", ".py", ".rb", ".service",
    ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml",
    ".yml", ".zsh",
}

def execution_context():
    windows = os.name == "nt"
    shell_candidates = {
        "bash": shutil.which("bash"),
        "sh": shutil.which("sh"),
        "pwsh": shutil.which("pwsh"),
        "powershell": shutil.which("powershell") or shutil.which("powershell.exe"),
        "cmd": shutil.which("cmd") or shutil.which("cmd.exe"),
    }
    preferred_shell = (
        shell_candidates["pwsh"] or shell_candidates["powershell"] or shell_candidates["cmd"]
        if windows
        else shell_candidates["bash"] or shell_candidates["sh"]
    )
    return {
        "platform": "windows" if windows else "posix",
        "system": platform.system(),
        "path_separator": os.sep,
        "path_list_separator": os.pathsep,
        "native_line_endings": "crlf" if windows else "lf",
        "python_executable": sys.executable,
        "preferred_shell": preferred_shell,
        "shells": shell_candidates,
        "transport": "structured_argv_and_stdin",
        "constraints": [
            "Use exec_argv for one program; argv is not parsed by a shell.",
            "Use the matching script tool only when shell syntax is required.",
            "Remote paths must use the reported platform path separator.",
            "Text writes and uploads default to safe target-aware line-ending normalization.",
        ],
    }

def target_line_ending(path, mode):
    if mode == "lf":
        return b"\n", "lf"
    if mode == "crlf":
        return b"\r\n", "crlf"
    suffix = path.suffix.lower()
    if suffix in {".sh", ".bash", ".zsh"}:
        return b"\n", "lf"
    if suffix in {".bat", ".cmd"}:
        return b"\r\n", "crlf"
    return (b"\r\n", "crlf") if os.name == "nt" else (b"\n", "lf")

def looks_like_text(path, data):
    if b"\0" in data:
        return False
    if path.suffix.lower() not in TEXT_SUFFIXES and not data.startswith(b"#!"):
        return False
    try:
        data.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False

def normalize_text_data(path, data, mode="auto", declared_text=False):
    if mode == "preserve":
        return data, {"line_endings": "preserve", "normalized": False}
    if mode not in {"auto", "lf", "crlf"}:
        raise ValueError("line_endings must be auto, preserve, lf, or crlf")
    if not declared_text and not looks_like_text(path, data):
        return data, {"line_endings": "preserve", "normalized": False, "reason": "not_confirmed_utf8_text"}
    text = data.decode("utf-8")
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    separator, resolved = target_line_ending(path, mode)
    encoded = normalized.replace("\n", separator.decode("ascii")).encode("utf-8")
    return encoded, {"line_endings": resolved, "normalized": encoded != data}

def normalize_text_file(payload):
    path = resolve_path(payload["path"])
    limit = int(payload.get("max_bytes", 16 * 1024 * 1024))
    if path.stat().st_size > limit:
        return {"path": str(path), "line_endings": "preserve", "normalized": False, "reason": "file_too_large"}
    data = path.read_bytes()
    normalized, metadata = normalize_text_data(path, data, payload.get("line_endings", "auto"))
    if metadata["normalized"]:
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(normalized)
                handle.flush()
                os.fsync(handle.fileno())
            shutil.copymode(path, temporary_name)
            os.replace(temporary_name, path)
        except BaseException:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise
    return {"path": str(path), "bytes": len(normalized), **metadata}

def run_script(payload):
    requested = payload.get("shell", "auto")
    context = execution_context()
    shells = context["shells"]
    if requested == "auto":
        choices = ["pwsh", "powershell", "cmd"] if os.name == "nt" else ["bash", "sh"]
        selected = next((name for name in choices if shells.get(name)), None)
    else:
        selected = requested if shells.get(requested) else None
    if not selected:
        raise RuntimeError(f"Requested shell {requested} is unavailable; detected shells: {shells}")

    strict = payload.get("strict_mode", True)
    script = payload["script"]
    if selected == "bash" and strict:
        script = "set -Eeuo pipefail\n" + script
    elif selected == "sh" and strict:
        script = "set -eu\n" + script
    elif selected in {"pwsh", "powershell"} and strict:
        script = "Set-StrictMode -Version Latest\n$ErrorActionPreference = 'Stop'\n" + script
    elif selected == "cmd" and any(ord(character) > 127 for character in script):
        script = "@chcp 65001 >nul\r\n" + script

    suffix = {"bash": ".sh", "sh": ".sh", "pwsh": ".ps1", "powershell": ".ps1", "cmd": ".cmd"}[selected]
    encoded, newline_metadata = normalize_text_data(
        pathlib.Path("script" + suffix), script.encode("utf-8"), "auto", True
    )
    if selected == "powershell":
        encoded = b"\xef\xbb\xbf" + encoded

    descriptor, script_path = tempfile.mkstemp(prefix="reliable-ssh-script-", suffix=suffix)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        if selected in {"bash", "sh"}:
            arguments = [script_path]
        elif selected in {"pwsh", "powershell"}:
            arguments = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script_path]
        else:
            arguments = ["/D", "/Q", "/C", script_path]
        result = run_process({
            "program": shells[selected],
            "args": arguments,
            "cwd": payload.get("cwd"),
            "env": payload.get("env", {}),
            "stdin_b64": "",
            "timeout_seconds": payload.get("timeout_seconds", 60),
            "max_output_bytes": payload.get("max_output_bytes", 1024 * 1024),
        })
        return {
            **result,
            "shell": selected,
            "shell_path": shells[selected],
            "script_line_endings": newline_metadata["line_endings"],
        }
    finally:
        try:
            os.unlink(script_path)
        except FileNotFoundError:
            pass

def probe_identity():
    ip_addresses = []
    try:
        completed = subprocess.run(
            ["hostname", "-I"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        )
        ip_addresses = completed.stdout.split()
    except (OSError, subprocess.SubprocessError):
        pass

    if not ip_addresses:
        try:
            hostname = socket.gethostname()
            for item in socket.getaddrinfo(hostname, None):
                address = item[4][0]
                if address not in ip_addresses:
                    ip_addresses.append(address)
        except OSError:
            pass

    gpus = []
    if shutil.which("nvidia-smi"):
        try:
            completed = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,uuid,driver_version", "--format=csv,noheader"],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=10,
            )
            for line in completed.stdout.splitlines():
                parts = [part.strip() for part in line.split(",", 2)]
                if len(parts) == 3:
                    gpus.append({"name": parts[0], "uuid": parts[1], "driver_version": parts[2]})
        except (OSError, subprocess.SubprocessError):
            pass

    uname = platform.uname()
    os_release = parse_os_release()
    uid_reader = getattr(os, "getuid", None)
    return {
        "hostname": socket.gethostname(),
        "ip_addresses": ip_addresses,
        "user": getpass.getuser(),
        "uid": uid_reader() if uid_reader else None,
        "python_version": platform.python_version(),
        "kernel": {
            "system": uname.system,
            "release": uname.release,
            "machine": uname.machine,
        },
        "os": {
            "name": os_release.get("NAME"),
            "pretty_name": os_release.get("PRETTY_NAME"),
            "version_id": os_release.get("VERSION_ID"),
        },
        "execution_context": execution_context(),
        "gpus": gpus,
    }

def resolve_path(raw_path):
    return pathlib.Path(raw_path).expanduser()

def stat_path(payload):
    path = resolve_path(payload["path"])
    info = path.stat()
    return {
        "path": str(path),
        "exists": True,
        "is_file": path.is_file(),
        "is_directory": path.is_dir(),
        "is_symlink": path.is_symlink(),
        "size_bytes": info.st_size,
        "mode": format(info.st_mode & 0o7777, "04o"),
        "modified_unix_ms": round(info.st_mtime * 1000),
    }

def read_file(payload):
    path = resolve_path(payload["path"])
    limit = payload["max_bytes"]
    with path.open("rb") as handle:
        data = handle.read(limit + 1)
    truncated = len(data) > limit
    data = data[:limit]
    return {
        "path": str(path),
        "data_b64": base64.b64encode(data).decode("ascii"),
        "returned_bytes": len(data),
        "truncated": truncated,
    }

def tail_file(payload):
    path = resolve_path(payload["path"])
    if not path.is_file():
        raise ValueError("Log path must be a regular file")
    size = path.stat().st_size
    limit = payload["max_bytes"]
    requested_offset = payload.get("offset_bytes")
    if requested_offset is None:
        offset = max(0, size - limit)
    else:
        offset = min(max(0, requested_offset), size)
    with path.open("rb") as handle:
        handle.seek(offset)
        data = handle.read(limit)
    return {
        "path": str(path),
        "offset_bytes": offset,
        "next_offset_bytes": offset + len(data),
        "size_bytes": size,
        "data_b64": base64.b64encode(data).decode("ascii"),
        "has_more": offset + len(data) < size,
    }

def scan_tcp(payload):
    network = ipaddress.ip_network(payload["cidr"], strict=True)
    if network.version != 4:
        raise ValueError("Only IPv4 discovery is supported")
    addresses = [str(address) for address in network.hosts()]
    max_hosts = payload["max_hosts"]
    if len(addresses) > max_hosts:
        raise ValueError(f"CIDR contains {len(addresses)} hosts; limit is {max_hosts}")
    port = payload["port"]
    timeout = payload["timeout_ms"] / 1000.0

    def probe(address):
        try:
            with socket.create_connection((address, port), timeout=timeout) as connection:
                banner = ""
                if port == 22:
                    connection.settimeout(timeout)
                    try:
                        banner = connection.recv(256).decode("utf-8", errors="replace").strip()
                    except OSError:
                        pass
                return {"address": address, "port": port, "banner": banner}
        except OSError:
            return None

    workers = min(payload.get("concurrency", 16), 32, max(1, len(addresses)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        results = [item for item in executor.map(probe, addresses) if item]
    results.sort(key=lambda item: ipaddress.ip_address(item["address"]))
    return {"cidr": str(network), "port": port, "hosts": results, "scanned_hosts": len(addresses)}

def scan_host_keys(payload):
    executable = shutil.which("ssh-keyscan")
    if not executable:
        raise RuntimeError("ssh-keyscan is not installed on the bastion")
    completed = subprocess.run(
        [
            executable,
            "-T",
            str(payload.get("timeout_seconds", 5)),
            "-p",
            str(payload["port"]),
            payload["host"],
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=payload.get("timeout_seconds", 5) + 5,
    )
    keys = []
    for line in completed.stdout.splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            digest = hashlib.sha256(base64.b64decode(parts[2])).digest()
        except (ValueError, TypeError):
            continue
        keys.append({
            "host_field": parts[0],
            "key_type": parts[1],
            "public_key": parts[2],
            "fingerprint": "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("="),
        })
    if not keys:
        details = completed.stderr.strip()
        raise RuntimeError("No SSH host keys returned" + (f": {details}" if details else ""))
    return {"host": payload["host"], "port": payload["port"], "keys": keys}

SESSION_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")

def session_state_root(payload):
    return resolve_path(payload.get("state_root") or "~/.local/state/reliable-ssh-mcp/sessions")

def session_directory(payload):
    name = payload["session_name"]
    if not SESSION_NAME.fullmatch(name):
        raise ValueError("Invalid tmux session name")
    return session_state_root(payload) / name

def tmux_alive(name):
    if not shutil.which("tmux"):
        return False
    completed = subprocess.run(
        ["tmux", "has-session", "-t", name],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return completed.returncode == 0

def tmux_session_status(payload):
    directory = session_directory(payload)
    metadata_path = directory / "metadata.json"
    if not metadata_path.is_file():
        raise ValueError(f"Unknown managed tmux session {payload['session_name']}")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    exit_path = directory / "exit_code"
    stopped_path = directory / "stopped"
    exit_code = None
    if exit_path.is_file():
        try:
            exit_code = int(exit_path.read_text(encoding="utf-8").strip())
        except ValueError:
            pass
    log_path = pathlib.Path(metadata["log_path"])
    alive = tmux_alive(payload["session_name"])
    return {
        **metadata,
        "alive": alive,
        "status": "running" if alive else ("stopped" if stopped_path.exists() else "completed"),
        "exit_code": exit_code,
        "log_size_bytes": log_path.stat().st_size if log_path.is_file() else 0,
    }

def start_tmux_session(payload):
    for executable in ("tmux", "bash", "tee"):
        if not shutil.which(executable):
            raise RuntimeError(f"{executable} is required for managed sessions")
    directory = session_directory(payload)
    name = payload["session_name"]
    if tmux_alive(name):
        raise ValueError(f"tmux session {name} already exists")
    if directory.exists():
        raise ValueError(f"Managed session state already exists for {name}; choose a new name")
    directory.mkdir(parents=True)
    log_path = resolve_path(payload.get("log_path") or str(directory / "output.log"))
    log_path.parent.mkdir(parents=True, exist_ok=True)
    status_path = directory / "exit_code"
    command = [payload["program"]] + payload.get("args", [])
    environment = [f"{key}={value}" for key, value in payload.get("env", {}).items()]
    exact_command = shlex.join(["env"] + environment + command)
    wrapper = (
        "set -o pipefail; "
        + exact_command
        + " 2>&1 | tee -a "
        + shlex.quote(str(log_path))
        + "; rc=\${PIPESTATUS[0]}; printf '%s\\n' \"$rc\" > "
        + shlex.quote(str(status_path))
        + "; exit \"$rc\""
    )
    shell_command = shlex.join(["bash", "-lc", wrapper])
    tmux_command = ["tmux", "new-session", "-d", "-s", name]
    if payload.get("cwd"):
        tmux_command.extend(["-c", payload["cwd"]])
    tmux_command.append(shell_command)
    completed = subprocess.run(
        tmux_command,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if completed.returncode != 0:
        shutil.rmtree(directory, ignore_errors=True)
        raise RuntimeError(completed.stderr.strip() or "Could not start tmux session")
    subprocess.run(
        ["tmux", "set-option", "-t", name, "history-limit", str(payload.get("history_lines", 100000))],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    metadata = {
        "session_name": name,
        "program": payload["program"],
        "args_count": len(payload.get("args", [])),
        "cwd": payload.get("cwd"),
        "env_keys": sorted(payload.get("env", {}).keys()),
        "log_path": str(log_path),
        "started_unix_ms": round(time.time() * 1000),
    }
    (directory / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
    return tmux_session_status(payload)

def list_tmux_sessions(payload):
    root = session_state_root(payload)
    if not root.exists():
        return []
    sessions = []
    for child in sorted(root.iterdir()):
        if not child.is_dir() or not SESSION_NAME.fullmatch(child.name):
            continue
        try:
            sessions.append(tmux_session_status({**payload, "session_name": child.name}))
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    return sessions

def capture_tmux_session(payload):
    status = tmux_session_status(payload)
    lines = payload.get("lines", 200)
    if status["alive"]:
        completed = subprocess.run(
            ["tmux", "capture-pane", "-p", "-t", payload["session_name"], "-S", f"-{lines}"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.decode("utf-8", errors="replace").strip())
        data = completed.stdout
        source = "tmux"
    else:
        log_path = pathlib.Path(status["log_path"])
        max_bytes = payload.get("max_bytes", 1024 * 1024)
        with log_path.open("rb") as handle:
            size = log_path.stat().st_size
            handle.seek(max(0, size - max_bytes))
            data = handle.read(max_bytes)
        source = "log"
    return {**status, "source": source, "data_b64": base64.b64encode(data).decode("ascii")}

def send_tmux_input(payload):
    name = payload["session_name"]
    if not tmux_alive(name):
        raise ValueError(f"tmux session {name} is not running")
    subprocess.run(["tmux", "send-keys", "-t", name, "-l", payload["text"]], check=True)
    if payload.get("enter", True):
        subprocess.run(["tmux", "send-keys", "-t", name, "Enter"], check=True)
    return {"session_name": name, "sent_characters": len(payload["text"]), "enter": payload.get("enter", True)}

def stop_tmux_session(payload):
    directory = session_directory(payload)
    name = payload["session_name"]
    if not (directory / "metadata.json").is_file():
        raise ValueError(f"Unknown managed tmux session {name}")
    was_alive = tmux_alive(name)
    if was_alive:
        subprocess.run(["tmux", "kill-session", "-t", name], check=True)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "stopped").write_text(str(round(time.time() * 1000)), encoding="utf-8")
    return {"session_name": name, "was_running": was_alive, "status": "stopped"}

def write_file(payload):
    path = resolve_path(payload["path"])
    data = base64.b64decode(payload["data_b64"])
    data, newline_metadata = normalize_text_data(
        path,
        data,
        payload.get("line_endings", "preserve"),
        payload.get("declared_text", False),
    )
    if payload.get("create_parents"):
        path.parent.mkdir(parents=True, exist_ok=True)

    if payload.get("atomic", True):
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            if payload.get("mode") is not None:
                os.chmod(temporary_name, payload["mode"])
            os.replace(temporary_name, path)
        except BaseException:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass
            raise
    else:
        with path.open("wb") as handle:
            handle.write(data)
        if payload.get("mode") is not None:
            os.chmod(path, payload["mode"])

    return {
        "path": str(path),
        "bytes_written": len(data),
        "atomic": payload.get("atomic", True),
        **newline_metadata,
    }

def create_archive(payload):
    source = resolve_path(payload["source_path"]).resolve()
    archive = resolve_path(payload["archive_path"])
    if not source.is_dir():
        raise ValueError("Archive source must be a directory")
    archive.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "w:gz") as handle:
        handle.add(source, arcname=source.name, recursive=True)
    return {"source_path": str(source), "archive_path": str(archive), "size_bytes": archive.stat().st_size}

def extract_archive(payload):
    archive = resolve_path(payload["archive_path"]).resolve()
    destination = resolve_path(payload["destination_path"])
    destination.mkdir(parents=True, exist_ok=True)
    destination = destination.resolve()
    extracted = 0
    normalized_files = 0
    newline_mode = payload.get("line_endings", "preserve")
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive, "r") as handle:
            members = handle.infolist()
            for member in members:
                target = (destination / member.filename).resolve()
                if os.path.commonpath([str(destination), str(target)]) != str(destination):
                    raise ValueError(f"Archive member escapes destination: {member.filename}")
                if member.is_dir():
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with handle.open(member, "r") as source, open(target, "wb") as output:
                    shutil.copyfileobj(source, output)
                if normalize_text_file({"path": str(target), "line_endings": newline_mode})["normalized"]:
                    normalized_files += 1
            extracted = len(members)
        return {"archive_path": str(archive), "destination_path": str(destination), "members_extracted": extracted, "normalized_text_files": normalized_files, "line_endings": newline_mode, "format": "zip"}
    with tarfile.open(archive, "r:gz") as handle:
        members = handle.getmembers()
        for member in members:
            target = (destination / member.name).resolve()
            if os.path.commonpath([str(destination), str(target)]) != str(destination):
                raise ValueError(f"Archive member escapes destination: {member.name}")
            if member.issym() or member.islnk():
                raise ValueError(f"Archive links are not allowed: {member.name}")
        handle.extractall(destination, members=members, filter="data")
        extracted = len(members)
        for member in members:
            if member.isfile():
                target = (destination / member.name).resolve()
                if normalize_text_file({"path": str(target), "line_endings": newline_mode})["normalized"]:
                    normalized_files += 1
    return {"archive_path": str(archive), "destination_path": str(destination), "members_extracted": extracted, "normalized_text_files": normalized_files, "line_endings": newline_mode, "format": "tar.gz"}

try:
    operation = PAYLOAD["operation"]
    if operation == "process":
        result = run_process(PAYLOAD)
    elif operation == "script":
        result = run_script(PAYLOAD)
    elif operation == "probe_identity":
        result = probe_identity()
    elif operation == "stat_path":
        result = stat_path(PAYLOAD)
    elif operation == "read_file":
        result = read_file(PAYLOAD)
    elif operation == "tail_file":
        result = tail_file(PAYLOAD)
    elif operation == "write_file":
        result = write_file(PAYLOAD)
    elif operation == "normalize_text_file":
        result = normalize_text_file(PAYLOAD)
    elif operation == "create_archive":
        result = create_archive(PAYLOAD)
    elif operation == "extract_archive":
        result = extract_archive(PAYLOAD)
    elif operation == "scan_tcp":
        result = scan_tcp(PAYLOAD)
    elif operation == "scan_host_keys":
        result = scan_host_keys(PAYLOAD)
    elif operation == "start_tmux_session":
        result = start_tmux_session(PAYLOAD)
    elif operation == "list_tmux_sessions":
        result = list_tmux_sessions(PAYLOAD)
    elif operation == "tmux_session_status":
        result = tmux_session_status(PAYLOAD)
    elif operation == "capture_tmux_session":
        result = capture_tmux_session(PAYLOAD)
    elif operation == "send_tmux_input":
        result = send_tmux_input(PAYLOAD)
    elif operation == "stop_tmux_session":
        result = stop_tmux_session(PAYLOAD)
    else:
        raise ValueError(f"Unsupported operation: {operation}")
    emit({"protocol": 1, "ok": True, "result": result})
except BaseException as error:
    emit({
        "protocol": 1,
        "ok": False,
        "error": {
            "type": type(error).__name__,
            "message": str(error),
            "traceback": traceback.format_exc(limit=8),
        },
    })
`;

export function buildRemoteRunner(payload) {
  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64",
  );
  return REMOTE_RUNNER.replace("__PAYLOAD_B64__", payloadBase64).trimStart();
}

export function buildRemoteDaemon() {
  const payloadLine =
    'PAYLOAD = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))';
  const dispatchMarker = '\ntry:\n    operation = PAYLOAD["operation"]';
  const payloadAt = REMOTE_RUNNER.indexOf(payloadLine);
  const dispatchAt = REMOTE_RUNNER.indexOf(dispatchMarker);
  if (payloadAt < 0 || dispatchAt < 0) {
    throw new Error("Could not construct the persistent remote runner");
  }
  const prefix = `${REMOTE_RUNNER.slice(0, payloadAt)}PAYLOAD = None${REMOTE_RUNNER.slice(payloadAt + payloadLine.length, dispatchAt)}`;
  const loop = String.raw`
for request_line in sys.stdin:
    request_line = request_line.strip()
    if not request_line:
        continue
    request_id = None
    try:
        request = json.loads(request_line)
        request_id = request.get("id")
        PAYLOAD = request["payload"]
        operation = PAYLOAD["operation"]
        if operation == "process":
            result = run_process(PAYLOAD)
        elif operation == "script":
            result = run_script(PAYLOAD)
        elif operation == "probe_identity":
            result = probe_identity()
        elif operation == "stat_path":
            result = stat_path(PAYLOAD)
        elif operation == "read_file":
            result = read_file(PAYLOAD)
        elif operation == "tail_file":
            result = tail_file(PAYLOAD)
        elif operation == "write_file":
            result = write_file(PAYLOAD)
        elif operation == "normalize_text_file":
            result = normalize_text_file(PAYLOAD)
        elif operation == "create_archive":
            result = create_archive(PAYLOAD)
        elif operation == "extract_archive":
            result = extract_archive(PAYLOAD)
        elif operation == "scan_tcp":
            result = scan_tcp(PAYLOAD)
        elif operation == "scan_host_keys":
            result = scan_host_keys(PAYLOAD)
        elif operation == "start_tmux_session":
            result = start_tmux_session(PAYLOAD)
        elif operation == "list_tmux_sessions":
            result = list_tmux_sessions(PAYLOAD)
        elif operation == "tmux_session_status":
            result = tmux_session_status(PAYLOAD)
        elif operation == "capture_tmux_session":
            result = capture_tmux_session(PAYLOAD)
        elif operation == "send_tmux_input":
            result = send_tmux_input(PAYLOAD)
        elif operation == "stop_tmux_session":
            result = stop_tmux_session(PAYLOAD)
        else:
            raise ValueError(f"Unsupported operation: {operation}")
        emit({"id": request_id, "protocol": 1, "ok": True, "result": result})
    except BaseException as error:
        emit({
            "id": request_id,
            "protocol": 1,
            "ok": False,
            "error": {
                "type": type(error).__name__,
                "message": str(error),
                "traceback": traceback.format_exc(limit=8),
            },
        })
    sys.stdout.write("\n")
    sys.stdout.flush()
`;
  return `${prefix}${loop}`.trimStart();
}

export function parseRemoteResponse(stdout) {
  let response;
  try {
    response = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Remote runner returned invalid JSON: ${error.message}`);
  }
  if (response.protocol !== 1 || typeof response.ok !== "boolean") {
    throw new Error("Remote runner returned an unsupported response");
  }
  if (!response.ok) {
    const remoteError = response.error ?? {};
    throw new Error(
      `Remote ${remoteError.type ?? "error"}: ${remoteError.message ?? "unknown failure"}`,
    );
  }
  return response.result;
}

export function decodeCapturedStream(stream) {
  return {
    text: Buffer.from(stream.data_b64, "base64").toString("utf8"),
    size_bytes: stream.size_bytes,
    truncated: stream.truncated,
  };
}
