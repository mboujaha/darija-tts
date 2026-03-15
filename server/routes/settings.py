import base64
import io
import json
from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import Optional
import paramiko
from server import db

router = APIRouter(prefix="/api/settings", tags=["settings"])


class RemoteServerConfig(BaseModel):
    host: str
    port: int = 22
    username: str
    auth_method: str = "key"  # "key" or "password"
    password: Optional[str] = None
    private_key_pem: Optional[str] = None  # PEM-encoded private key
    private_key_passphrase: Optional[str] = None
    remote_data_dir: str = "/home/user/darija-tts/data"
    remote_checkpoints_dir: str = "/home/user/darija-tts/checkpoints"
    remote_python: str = "python3"


class GeneralSettings(BaseModel):
    hf_token: Optional[str] = None
    default_whisper_model: Optional[str] = "large-v3"
    default_min_snr: Optional[float] = 15.0
    default_min_confidence: Optional[float] = 0.6


@router.get("")
async def get_settings():
    all_settings = await db.get_all_settings()
    # Redact sensitive fields
    if "remote_server" in all_settings:
        srv = all_settings["remote_server"]
        if isinstance(srv, dict):
            if srv.get("password"):
                srv["password"] = "**redacted**"
            if srv.get("private_key_passphrase"):
                srv["private_key_passphrase"] = "**redacted**"
            if srv.get("private_key_pem"):
                srv["private_key_pem"] = "**stored**"
    return all_settings


@router.get("/remote-server")
async def get_remote_server():
    cfg = await db.get_setting("remote_server", {})
    if isinstance(cfg, dict):
        if cfg.get("password"):
            cfg["password"] = "**redacted**"
        if cfg.get("private_key_passphrase"):
            cfg["private_key_passphrase"] = "**redacted**"
        if cfg.get("private_key_pem"):
            cfg["private_key_pem"] = "**stored**"
    return cfg or {}


@router.put("/remote-server")
async def update_remote_server(config: RemoteServerConfig):
    existing = await db.get_setting("remote_server", {}) or {}
    data = config.model_dump()
    # If user sends redacted placeholders, keep existing values
    if data.get("password") in ("**redacted**", None) and existing.get("password"):
        data["password"] = existing["password"]
    if data.get("private_key_passphrase") in ("**redacted**", None) and existing.get("private_key_passphrase"):
        data["private_key_passphrase"] = existing["private_key_passphrase"]
    if data.get("private_key_pem") in ("**stored**", None) and existing.get("private_key_pem"):
        data["private_key_pem"] = existing["private_key_pem"]
    await db.set_setting("remote_server", data)
    return {"ok": True}


@router.post("/remote-server/upload-key")
async def upload_ssh_key(file: UploadFile = File(...)):
    """Upload a PEM private key file."""
    content = await file.read()
    try:
        pem_str = content.decode("utf-8")
        # Validate it looks like a PEM key
        if "BEGIN" not in pem_str and "PRIVATE KEY" not in pem_str and "OPENSSH" not in pem_str:
            raise ValueError("Not a valid PEM key file")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Key file must be UTF-8 encoded PEM")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    existing = await db.get_setting("remote_server", {}) or {}
    existing["private_key_pem"] = pem_str
    existing["auth_method"] = "key"
    await db.set_setting("remote_server", existing)
    return {"ok": True, "message": "SSH key uploaded successfully"}


@router.post("/remote-server/test-connection")
async def test_remote_connection():
    """Test SSH connection to the remote training server."""
    cfg = await db.get_setting("remote_server", {})
    if not cfg:
        raise HTTPException(status_code=400, detail="No remote server configured")

    host = cfg.get("host")
    port = cfg.get("port", 22)
    username = cfg.get("username")
    auth_method = cfg.get("auth_method", "key")

    if not host or not username:
        raise HTTPException(status_code=400, detail="Host and username are required")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        connect_kwargs = dict(
            hostname=host,
            port=port,
            username=username,
            timeout=10,
        )

        if auth_method == "key" and cfg.get("private_key_pem"):
            pem_bytes = cfg["private_key_pem"].encode("utf-8")
            passphrase = cfg.get("private_key_passphrase") or None
            key_file = io.StringIO(cfg["private_key_pem"])
            # Try common key types
            pkey = None
            for key_cls in [paramiko.RSAKey, paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.DSSKey]:
                try:
                    key_file.seek(0)
                    pkey = key_cls.from_private_key(key_file, password=passphrase)
                    break
                except Exception:
                    continue
            if pkey is None:
                raise HTTPException(status_code=400, detail="Could not parse private key. Check key format and passphrase.")
            connect_kwargs["pkey"] = pkey
        elif auth_method == "password" and cfg.get("password"):
            connect_kwargs["password"] = cfg["password"]
        else:
            raise HTTPException(status_code=400, detail="No valid credentials configured")

        client.connect(**connect_kwargs)

        # Run a quick test command
        stdin, stdout, stderr = client.exec_command("echo ok && python3 --version && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo 'no-gpu'")
        output = stdout.read().decode().strip()
        err = stderr.read().decode().strip()
        client.close()

        lines = output.split("\n")
        gpu_info = lines[2] if len(lines) > 2 else "unknown"
        python_ver = lines[1] if len(lines) > 1 else "unknown"

        return {
            "ok": True,
            "message": "Connection successful",
            "python_version": python_ver,
            "gpu_info": gpu_info,
        }
    except paramiko.AuthenticationException:
        raise HTTPException(status_code=401, detail="Authentication failed — check credentials")
    except paramiko.SSHException as e:
        raise HTTPException(status_code=500, detail=f"SSH error: {str(e)}")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Connection failed: {str(e)}")
    finally:
        try:
            client.close()
        except Exception:
            pass


@router.get("/general")
async def get_general_settings():
    result = {}
    result["hf_token"] = "**redacted**" if await db.get_setting("hf_token") else ""
    result["default_whisper_model"] = await db.get_setting("default_whisper_model", "large-v3")
    result["default_min_snr"] = await db.get_setting("default_min_snr", 15.0)
    result["default_min_confidence"] = await db.get_setting("default_min_confidence", 0.6)
    return result


@router.put("/general")
async def update_general_settings(settings: GeneralSettings):
    if settings.hf_token and settings.hf_token != "**redacted**":
        await db.set_setting("hf_token", settings.hf_token)
    if settings.default_whisper_model:
        await db.set_setting("default_whisper_model", settings.default_whisper_model)
    if settings.default_min_snr is not None:
        await db.set_setting("default_min_snr", settings.default_min_snr)
    if settings.default_min_confidence is not None:
        await db.set_setting("default_min_confidence", settings.default_min_confidence)
    return {"ok": True}
