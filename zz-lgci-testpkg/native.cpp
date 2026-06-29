// Throwaway native fixture for PR #2873 detection validation.
// Its presence in base..head makes the OLD (base..head) logic report a native
// change on a label-only event, while the NEW logic (head..head) correctly
// reports none. Delete with the sandbox branch.
int lgci_native_marker() { return 1; }
