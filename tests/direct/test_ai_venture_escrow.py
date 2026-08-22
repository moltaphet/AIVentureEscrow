"""Direct-mode lifecycle and access-control tests for AI Venture Escrow."""

import datetime
import json
from pathlib import Path

import pytest


CONTRACT = str(Path(__file__).resolve().parents[2] / "contracts" / "ai_venture_escrow.py")
TOTAL = 10**18
TRANCHE = 4 * 10**17
URL_PATTERN = r"^https://evidence\.example\.com/.*"
PROMPT_PATTERN = r".*Return JSON only with exactly these fields.*"


def address_value(raw):
    """Normalize a fixture address for constructor and method calldata."""
    if hasattr(raw, "as_hex"):
        return raw
    from genlayer.py.types import Address

    return Address(raw)


def address_hex(raw) -> str:
    if hasattr(raw, "as_hex"):
        return raw.as_hex
    return "0x" + raw.hex()


def deploy_escrow(direct_vm, direct_deploy, funder, creator, total=TOTAL):
    direct_vm.value = total
    try:
        return direct_deploy(
            CONTRACT,
            funder,
            creator,
            total,
        )
    finally:
        direct_vm.value = 0


def add_milestone(direct_vm, contract, funder, amount=TRANCHE):
    direct_vm.sender = funder
    contract.add_milestone(
        1,
        "Ship the escrow dashboard",
        "Public URL must show the deployed dashboard and release notes",
        amount,
    )


def submit_milestone(direct_vm, contract, creator):
    direct_vm.sender = creator
    contract.submit_milestone_deliverable(
        1,
        "https://evidence.example.com/release-1",
        "Dashboard deployed with the requested release notes.",
    )


def warp_to(direct_vm, timestamp: int) -> None:
    target = datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc)
    direct_vm.warp(target.isoformat().replace("+00:00", "Z"))


def prepare_for_evaluation(direct_vm, contract, creator):
    submit_milestone(direct_vm, contract, creator)
    available_at = contract.get_milestone(1)["evaluation_available_at"]
    warp_to(direct_vm, available_at + 1)


def mock_evaluation(direct_vm, decision, body="Dashboard release 1 is deployed."):
    direct_vm.mock_web(URL_PATTERN, {"status": 200, "body": body})
    direct_vm.mock_llm(
        PROMPT_PATTERN,
        json.dumps({"decision": decision, "reason": "The public evidence matches the criteria."}),
    )


def test_constructor_rejects_overfunding(
    direct_vm, direct_deploy, direct_bob, direct_charlie
):
    # Attaching more native value than the declared total is rejected.
    direct_vm.value = TOTAL + 1
    with direct_vm.expect_revert("deployment value exceeds total_grant_amount"):
        direct_deploy(CONTRACT, direct_bob, direct_charlie, TOTAL)


def test_zero_value_deploy_is_funded_by_deposit_and_completes_milestone(
    direct_vm, direct_deploy, direct_bob, direct_charlie
):
    # Zero-value deployment is allowed; the escrow starts empty and unfunded.
    contract = direct_deploy(CONTRACT, direct_bob, direct_charlie, TOTAL)
    grant = contract.get_grant()
    assert grant["total_grant_amount"] == TOTAL
    assert grant["funded_amount"] == 0
    assert grant["escrowed_funds"] == 0

    # A tranche cannot be allocated before the escrow holds native GEN.
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("funding exceeds escrowed balance"):
        contract.add_milestone(1, "Ship dashboard", "Public release URL", TRANCHE)

    # Only the funder or owner may deposit.
    direct_vm.sender = direct_charlie
    direct_vm.value = TRANCHE
    with direct_vm.expect_revert("only funder or owner"):
        contract.deposit_grant()
    direct_vm.value = 0

    # The funder deposits native GEN to back the escrow.
    direct_vm.sender = direct_bob
    direct_vm.value = TOTAL
    contract.deposit_grant()
    direct_vm.value = 0
    grant = contract.get_grant()
    assert grant["funded_amount"] == TOTAL
    assert grant["escrowed_funds"] == TOTAL

    # Depositing beyond the declared total is rejected.
    direct_vm.value = 1
    with direct_vm.expect_revert("deposit exceeds total grant amount"):
        contract.deposit_grant()
    direct_vm.value = 0

    # The full milestone lifecycle now works on the separately funded escrow.
    add_milestone(direct_vm, contract, direct_bob)
    prepare_for_evaluation(direct_vm, contract, direct_charlie)
    direct_vm.sender = direct_bob
    mock_evaluation(direct_vm, "MAJORITY_AGREE")
    assert contract.evaluate_and_release_milestone(1) == "MAJORITY_AGREE"

    direct_vm.sender = direct_charlie
    contract.claim_funds()
    grant = contract.get_grant()
    assert grant["released_funds"] == TRANCHE
    assert grant["creator_pending_payout"] == TRANCHE


def test_constructor_requires_distinct_funder_and_creator(
    direct_vm, direct_deploy, direct_bob
):
    direct_vm.value = TOTAL
    with direct_vm.expect_revert("funder and creator must differ"):
        direct_deploy(CONTRACT, direct_bob, direct_bob, TOTAL)


def test_constructor_records_roles_and_balance(
    direct_vm, direct_deploy, direct_bob, direct_charlie
):
    contract = deploy_escrow(direct_vm, direct_deploy, direct_bob, direct_charlie)
    grant = contract.get_grant()
    assert grant["owner"].lower() == address_hex(direct_vm.sender).lower()
    assert grant["funder"].lower() == address_hex(direct_bob).lower()
    assert grant["creator"].lower() == address_hex(direct_charlie).lower()
    assert grant["escrowed_funds"] == TOTAL


def test_admin_allocates_tranche_and_only_creator_can_submit(
    direct_vm, direct_deploy, direct_bob, direct_charlie
):
    contract = deploy_escrow(direct_vm, direct_deploy, direct_bob, direct_charlie)

    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("only owner or admin"):
        contract.add_milestone(1, "Ship dashboard", "Public release URL", TRANCHE)

    add_milestone(direct_vm, contract, direct_bob)
    accounting = contract.get_grant()
    assert accounting["allocated_funds"] == TRANCHE
    assert accounting["reserved_funds"] == TRANCHE
    assert accounting["escrowed_funds"] == TOTAL
    assert contract.get_milestone_ids() == [1]

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("only creator can submit"):
        contract.submit_milestone_deliverable(
            1, "https://evidence.example.com/release-1", "Forged submission"
        )

    submit_milestone(direct_vm, contract, direct_charlie)
    milestone = contract.get_milestone(1)
    assert milestone["status"] == "PENDING"
    assert milestone["submitted_at"] > 0
    assert milestone["evaluation_available_at"] > milestone["submitted_at"]

    direct_vm.sender = direct_charlie
    warp_to(direct_vm, milestone["evaluation_available_at"] + 1)
    with direct_vm.expect_revert("only owner, funder, or admin"):
        contract.evaluate_and_release_milestone(1)


def test_evaluation_waits_for_timeout_and_approval_releases_tranche(
    direct_vm, direct_deploy, direct_bob, direct_charlie
):
    contract = deploy_escrow(direct_vm, direct_deploy, direct_bob, direct_charlie)
    add_milestone(direct_vm, contract, direct_bob)
    submit_milestone(direct_vm, contract, direct_charlie)

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("dispute timeout is still active"):
        contract.evaluate_and_release_milestone(1)

    available_at = contract.get_milestone(1)["evaluation_available_at"]
    warp_to(direct_vm, available_at + 1)
    mock_evaluation(direct_vm, "MAJORITY_AGREE")
    assert contract.evaluate_and_release_milestone(1) == "MAJORITY_AGREE"

    milestone = contract.get_milestone(1)
    grant = contract.get_grant()
    assert milestone["status"] == "APPROVED"
    assert milestone["evaluation_attempted"] is True
    assert grant["reserved_funds"] == 0
    assert grant["released_funds"] == TRANCHE
    assert grant["escrowed_funds"] == TOTAL - TRANCHE


def test_transferred_admin_can_evaluate_without_revoking_funder_access(
    direct_vm, direct_deploy, direct_bob, direct_charlie
):
    contract = deploy_escrow(direct_vm, direct_deploy, direct_bob, direct_charlie)
    owner = address_value(direct_vm.sender)
    add_milestone(direct_vm, contract, direct_bob)
    submit_milestone(direct_vm, contract, direct_charlie)
    available_at = contract.get_milestone(1)["evaluation_available_at"]
    warp_to(direct_vm, available_at + 1)

    new_admin = b"\x11" * 20
    direct_vm.sender = owner
    contract.set_admin(address_value(new_admin))

    direct_vm.sender = new_admin
    mock_evaluation(direct_vm, "MAJORITY_REJECT")
    assert contract.evaluate_and_release_milestone(1) == "MAJORITY_REJECT"


def test_creator_cannot_evaluate_even_when_assigned_as_admin(
    direct_vm, direct_deploy, direct_bob, direct_charlie
):
    contract = deploy_escrow(direct_vm, direct_deploy, direct_bob, direct_charlie)
    owner = address_value(direct_vm.sender)
    add_milestone(direct_vm, contract, direct_bob)
    submit_milestone(direct_vm, contract, direct_charlie)
    available_at = contract.get_milestone(1)["evaluation_available_at"]
    warp_to(direct_vm, available_at + 1)

    direct_vm.sender = owner
    contract.set_admin(address_value(direct_charlie))
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("creator cannot evaluate own work"):
        contract.evaluate_and_release_milestone(1)


def test_forged_error_callback_cannot_restore_creator_payout(
    direct_vm, direct_deploy, direct_bob, direct_charlie
):
    contract = deploy_escrow(direct_vm, direct_deploy, direct_bob, direct_charlie)
    add_milestone(direct_vm, contract, direct_bob)
    prepare_for_evaluation(direct_vm, contract, direct_charlie)

    direct_vm.sender = direct_bob
    mock_evaluation(direct_vm, "MAJORITY_AGREE")
    contract.evaluate_and_release_milestone(1)

    direct_vm.sender = direct_charlie
    contract.claim_funds()
    grant = contract.get_grant()
    assert grant["creator_claimable_funds"] == 0
    assert grant["creator_pending_payout"] == TRANCHE

    direct_vm.value = TRANCHE
    contract.__on_errored_message__()
    direct_vm.value = 0
    grant = contract.get_grant()
    assert grant["creator_claimable_funds"] == 0
    assert grant["creator_pending_payout"] == TRANCHE

    with direct_vm.expect_revert("no claimable funds"):
        contract.claim_funds()


def test_rejection_is_one_shot_and_reclaimable_after_buffer(
    direct_vm, direct_deploy, direct_bob, direct_charlie
):
    contract = deploy_escrow(direct_vm, direct_deploy, direct_bob, direct_charlie)
    add_milestone(direct_vm, contract, direct_bob)
    prepare_for_evaluation(direct_vm, contract, direct_charlie)

    direct_vm.sender = direct_bob
    mock_evaluation(direct_vm, "MAJORITY_REJECT")
    assert contract.evaluate_and_release_milestone(1) == "MAJORITY_REJECT"

    rejected = contract.get_milestone(1)
    assert rejected["status"] == "REJECTED"
    assert rejected["reclaim_available_at"] > rejected["evaluated_at"]

    with direct_vm.expect_revert("milestone is not pending"):
        contract.evaluate_and_release_milestone(1)

    with direct_vm.expect_revert("reclaim timeout is still active"):
        contract.reclaim_rejected_milestone(1)

    warp_to(direct_vm, rejected["reclaim_available_at"] + 1)
    contract.reclaim_rejected_milestone(1)
    milestone = contract.get_milestone(1)
    grant = contract.get_grant()
    assert milestone["reclaimed"] is True
    assert grant["rejected_funds"] == 0
    assert grant["reclaimed_funds"] == TRANCHE
    assert grant["escrowed_funds"] == TOTAL - TRANCHE


def test_funder_reclaim_is_pull_payment_and_forged_callback_cannot_restore_it(
    direct_vm, direct_deploy, direct_bob, direct_charlie
):
    contract = deploy_escrow(direct_vm, direct_deploy, direct_bob, direct_charlie)
    add_milestone(direct_vm, contract, direct_bob)
    prepare_for_evaluation(direct_vm, contract, direct_charlie)

    direct_vm.sender = direct_bob
    mock_evaluation(direct_vm, "MAJORITY_REJECT")
    contract.evaluate_and_release_milestone(1)
    rejected = contract.get_milestone(1)
    warp_to(direct_vm, rejected["reclaim_available_at"] + 1)
    contract.reclaim_rejected_milestone(1)

    direct_vm.sender = direct_bob
    contract.claim_funds()
    grant = contract.get_grant()
    assert grant["funder_claimable_funds"] == 0
    assert grant["funder_pending_payout"] == TRANCHE

    direct_vm.value = TRANCHE
    contract.__on_errored_message__()
    direct_vm.value = 0
    grant = contract.get_grant()
    assert grant["funder_claimable_funds"] == 0
    assert grant["funder_pending_payout"] == TRANCHE

    with direct_vm.expect_revert("no claimable funds"):
        contract.claim_funds()


def test_unallocated_funds_can_be_reclaimed_once_and_cannot_be_reallocated(
    direct_vm, direct_deploy, direct_bob, direct_charlie
):
    contract = deploy_escrow(direct_vm, direct_deploy, direct_bob, direct_charlie)

    direct_vm.sender = direct_bob
    contract.reclaim_unallocated_funds()
    grant = contract.get_grant()
    assert grant["unallocated_reclaimed_funds"] == TOTAL
    assert grant["funder_claimable_funds"] == TOTAL
    assert grant["escrowed_funds"] == 0

    with direct_vm.expect_revert("no unallocated funds remain"):
        contract.reclaim_unallocated_funds()
    with direct_vm.expect_revert("funding exceeds unallocated grant"):
        contract.add_milestone(1, "Ship dashboard", "Public release URL", TRANCHE)


def test_unsubmitted_milestone_can_be_reclaimed_after_submission_deadline(
    direct_vm, direct_deploy, direct_bob, direct_charlie
):
    contract = deploy_escrow(direct_vm, direct_deploy, direct_bob, direct_charlie)
    add_milestone(direct_vm, contract, direct_bob)
    milestone = contract.get_milestone(1)

    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("only funder or owner"):
        contract.reclaim_unsubmitted_milestone(1)

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("submission deadline is still active"):
        contract.reclaim_unsubmitted_milestone(1)

    warp_to(direct_vm, milestone["submission_deadline"] + 1)
    contract.reclaim_unsubmitted_milestone(1)
    state = contract.get_milestone(1)
    grant = contract.get_grant()
    assert state["status"] == "REJECTED"
    assert state["reclaimed"] is True
    assert grant["reserved_funds"] == 0
    assert grant["reclaimed_funds"] == TRANCHE
    assert grant["funder_claimable_funds"] == TRANCHE


def test_validator_replay_rejects_different_decision(
    direct_vm, direct_deploy, direct_bob, direct_charlie
):
    contract = deploy_escrow(direct_vm, direct_deploy, direct_bob, direct_charlie)
    add_milestone(direct_vm, contract, direct_bob)
    prepare_for_evaluation(direct_vm, contract, direct_charlie)

    direct_vm.sender = direct_bob
    mock_evaluation(direct_vm, "MAJORITY_AGREE")
    contract.evaluate_and_release_milestone(1)

    direct_vm.clear_mocks()
    mock_evaluation(direct_vm, "MAJORITY_REJECT")
    assert direct_vm.run_validator() is False


def test_external_evaluation_failure_consumes_milestone(
    direct_vm, direct_deploy, direct_bob, direct_charlie
):
    contract = deploy_escrow(direct_vm, direct_deploy, direct_bob, direct_charlie)
    add_milestone(direct_vm, contract, direct_bob)
    prepare_for_evaluation(direct_vm, contract, direct_charlie)

    direct_vm.sender = direct_bob
    assert contract.evaluate_and_release_milestone(1) == "MAJORITY_REJECT"
    milestone = contract.get_milestone(1)
    grant = contract.get_grant()
    assert milestone["status"] == "REJECTED"
    assert milestone["evaluation_attempted"] is True
    assert grant["rejected_funds"] == TRANCHE
