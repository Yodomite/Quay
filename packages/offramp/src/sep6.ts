export interface Sep6WithdrawResult {
  id: string;
  accountId?: string;
}

export interface Sep6TransactionResult {
  id: string;
  status: string;
  amountOut?: string;
  message?: string;
}

/** SEP-6: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0006.md */
export async function startSep6Withdraw(
  baseUrl: string,
  jwt: string,
  input: {
    assetCode: string;
    amount: string;
    account: string;
    type: string;
    dest?: string;
    destExtra?: string;
  },
): Promise<Sep6WithdrawResult> {
  const url = new URL("/sep6/withdraw", baseUrl);
  url.searchParams.set("asset_code", input.assetCode);
  url.searchParams.set("amount", input.amount);
  url.searchParams.set("account", input.account);
  url.searchParams.set("type", input.type);
  if (input.dest) url.searchParams.set("dest", input.dest);
  if (input.destExtra) url.searchParams.set("dest_extra", input.destExtra);

  const res = await fetch(url, { headers: { authorization: `Bearer ${jwt}` } });
  if (!res.ok) {
    throw new Error(`SEP-6 withdraw failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string; account_id?: string };
  return { id: body.id, accountId: body.account_id };
}

export async function getSep6Transaction(
  baseUrl: string,
  jwt: string,
  id: string,
): Promise<Sep6TransactionResult> {
  const url = new URL("/sep6/transaction", baseUrl);
  url.searchParams.set("id", id);

  const res = await fetch(url, { headers: { authorization: `Bearer ${jwt}` } });
  if (!res.ok) {
    throw new Error(`SEP-6 transaction fetch failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    transaction: { id: string; status: string; amount_out?: string; message?: string };
  };
  return {
    id: body.transaction.id,
    status: body.transaction.status,
    amountOut: body.transaction.amount_out,
    message: body.transaction.message,
  };
}
