"""Direct-mode fixtures for the AI Venture Escrow contract."""

from pathlib import Path

import pytest
from gltest.direct.loader import deploy_contract
from gltest.direct.sdk_loader import setup_sdk_paths


CONTRACT = Path(__file__).resolve().parents[2] / "contracts" / "ai_venture_escrow.py"


@pytest.fixture
def direct_deploy(direct_vm):
    """Deploy with fixture addresses converted after the SDK is available."""

    def deploy(path, *args, sdk_version=None, **kwargs):
        contract_path = Path(path)
        if not contract_path.is_absolute():
            contract_path = Path.cwd() / contract_path
        contract_path = contract_path.resolve()

        setup_sdk_paths(contract_path, sdk_version)
        from genlayer.py.types import Address

        normalized_args = tuple(
            Address(value) if isinstance(value, bytes) and len(value) == 20 else value
            for value in args
        )
        return deploy_contract(
            contract_path,
            direct_vm,
            *normalized_args,
            sdk_version=sdk_version,
            **kwargs,
        )

    return deploy
