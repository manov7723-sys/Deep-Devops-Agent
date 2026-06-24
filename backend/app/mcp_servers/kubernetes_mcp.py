import os
import logging

logger = logging.getLogger(__name__)


def get_kubernetes_config() -> dict:
    """MCP server for live Kubernetes operations (apply manifests, get pods, scale, logs…).

    Only enabled when a kubeconfig is present — i.e. after the EKS cluster is up and
    `aws eks update-kubeconfig` has been run (see the connect_eks_kubeconfig tool). Until then
    it returns nothing so it doesn't add tool schemas / token cost to every request.
    """
    kubeconfig = os.getenv("KUBECONFIG") or os.path.expanduser("~/.kube/config")
    if not os.path.exists(kubeconfig):
        logger.info("MCP: Kubernetes server skipped — no kubeconfig yet")
        return {}

    return {
        "kubernetes": {
            "command": "npx",
            "args": ["-y", "mcp-server-kubernetes"],
            "env": {"KUBECONFIG": kubeconfig},
            "transport": "stdio",
        }
    }
