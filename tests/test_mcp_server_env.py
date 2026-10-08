"""A stdio MCP server does not inherit MISAKA's API keys (issue #10, the key-channel report).

MISAKA loads the home's .env -- search keys, the OpenAlex key -- into its environment, and every
MCP server started with all of it. A server now gets Hermes' safe names, the proxy and certificate
variables, and its own configured env, where ${VAR} takes a value from the environment."""
from misaka.core import mcp

ENVIRON = {"PATH": "/usr/bin", "HOME": "/home/u", "LANG": "C.UTF-8", "LC_CTYPE": "UTF-8", "XDG_CACHE_HOME": "/c",
           "HTTPS_PROXY": "http://127.0.0.1:7890", "no_proxy": "localhost", "SSL_CERT_FILE": "/ca.pem",
           "MISAKA_HOME": "/m", "OPENAI_API_KEY": "sk-secret", "EXA_API_KEY": "exa-secret",
           "GITHUB_TOKEN": "ghp-secret", "MISAKA_USAGE_DB": "/m/board.db", "Path": "C:\\Windows", "SystemRoot": "C:\\Windows"}


def test_a_server_gets_the_safe_names_and_no_key():
    env = mcp.inherited_env(ENVIRON)
    assert {"PATH", "HOME", "LANG", "LC_CTYPE", "XDG_CACHE_HOME", "HTTPS_PROXY", "no_proxy", "SSL_CERT_FILE",
            "MISAKA_HOME", "SystemRoot"} <= set(env)
    assert not {"OPENAI_API_KEY", "EXA_API_KEY", "GITHUB_TOKEN", "MISAKA_USAGE_DB"} & set(env)


def test_a_key_a_server_needs_is_named_in_its_env():
    env = mcp.configured_env({"GITHUB_TOKEN": "${GITHUB_TOKEN}", "MODE": "x-${MISSING}", "N": 3}, ENVIRON)
    assert env == {"GITHUB_TOKEN": "ghp-secret", "MODE": "x-${MISSING}", "N": "3"}


def test_an_npx_or_uvx_server_reaches_the_registry_the_user_set():
    """0.18.9 dropped the package managers' settings: behind a registry mirror or an npm proxy, an
    `npx -y` server fetched itself from the default registry and timed out."""
    mirrors = {"npm_config_registry": "https://registry.npmmirror.com", "npm_config_https_proxy": "http://p:1",
               "UV_INDEX_URL": "https://mirrors.example/simple", "PIP_INDEX_URL": "https://mirrors.example/simple",
               "UV_NATIVE_TLS": "1", "PYTHONUTF8": "1", "NODE_OPTIONS": "--use-openssl-ca"}
    env = mcp.inherited_env({**ENVIRON, **mirrors})
    assert mirrors.items() <= env.items()
    assert "OPENAI_API_KEY" not in env


def test_a_null_value_in_a_servers_env_is_no_value():
    assert mcp.configured_env({"TOKEN": None, "MODE": "a"}, ENVIRON) == {"MODE": "a"}


def test_a_registrys_credentials_stay_behind_with_the_ssh_agent():
    secrets = {"npm_config_//registry.npmjs.org/:_authToken": "npm-secret", "NPM_CONFIG__AUTH": "b64",
               "UV_INDEX_1_PASSWORD": "pw", "YARN_NPM_AUTH_TOKEN": "y", "UV_PUBLISH_TOKEN": "t",
               "PIP_CLIENT_CERT": "/c.pem", "SSH_AUTH_SOCK": "/tmp/agent.sock", "NPM_CONFIG_KEY": "-----BEGIN",
               "PIP_INDEX_URL": "https://user:pw@mirror.example/simple"}
    kept = {"npm_config_registry": "https://r", "UV_KEYRING_PROVIDER": "subprocess", "PIP_TRUSTED_HOST": "m",
            "npm_config_strict_ssl": "false", "UV_INDEX_STRATEGY": "unsafe-best-match"}
    env = mcp.inherited_env({**ENVIRON, **secrets, **kept})
    assert not set(secrets) & set(env) and kept.items() <= env.items()
