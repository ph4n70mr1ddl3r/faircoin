(() => {
  const state = {
    claims: [],
    merkleRoot: "",
    claimAmount: "100",
    provider: null,
    signer: null,
    walletAddress: "",
    chainId: "",
  };

  const $ = (id) => document.getElementById(id);

  async function fetchWithTimeout(url, options = {}, timeout = 10000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(id);
      return response;
    } catch (error) {
      clearTimeout(id);
      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeout}ms`);
      }
      throw error;
    }
  }

  async function fetchWithRetry(url, options = {}, maxRetries = 3, timeout = 10000) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetchWithTimeout(url, options, timeout);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
          throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
        }
        return response;
      } catch (err) {
        lastError = err;
        if (i < maxRetries - 1) {
          const delay = Math.pow(2, i) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

  function validateClaimsData(claims) {
    if (!Array.isArray(claims) || claims.length === 0) {
      throw new Error("Invalid claims data: must be non-empty array");
    }
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i];
      if (!claim || typeof claim !== 'object') {
        throw new Error(`Invalid claim at index ${i}: must be an object`);
      }
      if (!claim.address || typeof claim.address !== 'string') {
        throw new Error(`Invalid claim at index ${i}: missing address`);
      }
      if (!/^0x[a-fA-F0-9]{40}$/.test(claim.address)) {
        throw new Error(`Invalid claim at index ${i}: invalid address format`);
      }
      if (!Array.isArray(claim.proof)) {
        throw new Error(`Invalid claim at index ${i}: missing proof array`);
      }
    }
  }

  async function loadAirdrop() {
    try {
      const res = await fetchWithTimeout("./airdrop.json", {}, 10000);
      if (!res.ok) {
        throw new Error(`Failed to fetch airdrop.json: ${res.statusText}`);
      }
      const data = await res.json();
      if (!data.merkleRoot) {
        throw new Error("Invalid airdrop.json: missing merkleRoot");
      }
      if (!Array.isArray(data.claims)) {
        throw new Error("Invalid airdrop.json: claims must be an array");
      }
      validateClaimsData(data.claims);
      state.claims = data.claims || [];
      state.merkleRoot = (data.merkleRoot || "").toLowerCase();
      state.claimAmount = data.claimAmount || "100";
      render(data);
    } catch (err) {
      console.error("Error loading airdrop:", err.message);
      if ($("status")) {
        $("status").textContent = "Failed to load airdrop.json: " + err.message;
        $("status").className = "danger";
      }
    }
  }

  function render(data) {
    $("stat-root").textContent = shorten(state.merkleRoot);
    $("stat-claim").textContent = `${state.claimAmount} FAIR`;

    const tbody = $("sample-table")?.querySelector("tbody");
    if (tbody) {
      tbody.innerHTML = "";
      state.claims.forEach((claim, idx) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${claim.address}</td>
          <td><span class="muted">hidden</span></td>
          <td><code class="inline">${shorten((claim.proof || []).join(",") || "n/a")}</code></td>
        `;
        tbody.appendChild(tr);
      });
    }

    const accountSelect = $("account");
    if (accountSelect) {
      accountSelect.innerHTML = "";
      state.claims.forEach((claim, idx) => {
        const option = document.createElement("option");
        option.value = idx;
        option.textContent = `${idx + 1}. ${claim.address}`;
        accountSelect.appendChild(option);
      });
    }

    if (state.claims[0]) {
      selectAccount(0);
    }

    setWalletStatus();
  }

  function shorten(value) {
    if (!value) return "";
    return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
  }

  function selectAccount(idx) {
    const claim = state.claims[idx];
    if (!claim) return;
    $("address").value = claim.address;
    if ($("privateKey")) $("privateKey").value = "";
    $("proof").value = JSON.stringify(claim.proof || [], null, 2);
    $("status").textContent = "Proof pulled from the generated Merkle tree.";
    $("status").className = "success";

    if (state.walletAddress) {
      if (state.walletAddress.toLowerCase() === claim.address.toLowerCase()) {
        $("wallet-status").textContent = "Connected (address matches allowlist)";
        $("wallet-status").className = "pill success";
      } else {
        $("wallet-status").textContent = "Connected but address differs from selected entry";
        $("wallet-status").className = "pill danger";
      }
    }
  }

  function parseProof(text) {
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      if (parsed.some(item => !item || typeof item !== "string" || !item.startsWith("0x") || item.length !== 66)) {
        throw new Error("Invalid proof format");
      }
      return parsed;
    } catch (err) {
      console.error("Proof parsing error:", err.message);
      return [];
    }
  }

  function hashAddress(address) {
    try {
      const addr = ethers.getAddress(address);
      return ethers.keccak256(ethers.solidityPacked(["address"], [addr]));
    } catch (err) {
      console.error("Invalid address:", err.message);
      return null;
    }
  }

  function verifyProof(address, proof, root) {
    let hash = hashAddress(address);
    if (!hash) return false;
    for (const sibling of proof) {
      const a = ethers.getBytes(hash);
      const b = ethers.getBytes(sibling);
      const pair = ethers.hexlify(a) < ethers.hexlify(b) ? ethers.concat([a, b]) : ethers.concat([b, a]);
      hash = ethers.keccak256(pair);
    }
    return hash.toLowerCase() === root.toLowerCase();
  }

  function pickMetaMaskProvider() {
    const eth = window.ethereum;
    if (!eth) return null;
    if (eth.providers && Array.isArray(eth.providers)) {
      const mm = eth.providers.find((p) => p.isMetaMask);
      if (mm) return mm;
      return eth.providers[0];
    }
    return eth;
  }

  function setWalletStatus() {
    const addressEl = $("wallet-address");
    const chainEl = $("wallet-chain");
    if (!state.walletAddress) {
      $("wallet-status").textContent = "Not connected";
      $("wallet-status").className = "pill muted";
      addressEl.textContent = "—";
      addressEl.className = "stat muted";
      chainEl.textContent = "—";
      chainEl.className = "stat muted";
      return;
    }
    $("wallet-status").textContent = "Connected";
    $("wallet-status").className = "pill";
    addressEl.textContent = shorten(state.walletAddress);
    chainEl.textContent = state.chainId || "unknown";
    addressEl.className = "stat";
    chainEl.className = "stat";
  }

  async function fetchEligibility(address) {
    try {
      const res = await fetchWithRetry(`/api/eligibility?address=${encodeURIComponent(address)}`, {}, 2, 10000);
      return res.json();
    } catch (err) {
      console.error("Eligibility API error:", err.message);
      throw err;
    }
  }

  function applyEligibility(data) {
    if (!data) return;
    $("stat-root").textContent = shorten(data.merkleRoot);
    $("stat-claim").textContent = `${data.claimAmount} FAIR`;
    if (data.qualified) {
      $("status").textContent = "Address is qualified. Proof loaded from server.";
      $("status").className = "success";
      $("proof").value = JSON.stringify(data.proof || [], null, 2);
    } else {
      $("status").textContent = "Address is not whitelisted for the drop.";
      $("status").className = "danger";
      $("proof").value = "[]";
    }
  }

  async function connectWallet() {
    if (typeof window === 'undefined') {
      $("wallet-status").textContent = "Wallet not available in current environment.";
      $("wallet-status").className = "danger";
      return;
    }
    
    const injected = pickMetaMaskProvider();
    if (!injected) {
      $("wallet-status").textContent = "No injected wallet detected. Install MetaMask or enable an injected provider.";
      $("wallet-status").className = "danger";
      return;
    }
    
    try {
      $("wallet-status").textContent = "Connecting...";
      $("wallet-status").className = "pill";
      
      state.provider = new ethers.BrowserProvider(injected);
      await state.provider.send("eth_requestAccounts", []);
      state.signer = await state.provider.getSigner();
      state.walletAddress = ethers.getAddress(await state.signer.getAddress());
      const network = await state.provider.getNetwork();
      state.chainId = network.chainId?.toString?.() || "";
      setWalletStatus();
      $("address").value = state.walletAddress;

      const idx = state.claims.findIndex((c) => c.address.toLowerCase() === state.walletAddress.toLowerCase());
      if (idx >= 0) {
        $("account").value = idx;
        selectAccount(idx);
      }

      try {
        const eligibility = await fetchEligibility(state.walletAddress);
        applyEligibility(eligibility);
      } catch (err) {
        console.error("Eligibility lookup failed:", err.message);
        $("status").textContent = "Eligibility lookup failed.";
        $("status").className = "danger";
      }

      injected.removeListener?.("accountsChanged", onAccountsChanged);
      injected.on?.("accountsChanged", onAccountsChanged);
      injected.removeListener?.("chainChanged", onChainChanged);
      injected.on?.("chainChanged", onChainChanged);
    } catch (err) {
      console.error("Wallet connection error:", err.message);
      $("wallet-status").textContent = "Wallet connection rejected.";
      $("wallet-status").className = "danger";
    }
  }

  async function onAccountsChanged(accounts) {
    if (!accounts || accounts.length === 0) {
      state.walletAddress = "";
      state.signer = null;
      setWalletStatus();
      return;
    }
    state.walletAddress = ethers.getAddress(accounts[0]);
    state.signer = await state.provider.getSigner();
    const net = await state.provider.getNetwork();
    state.chainId = net.chainId?.toString?.() || "";
    setWalletStatus();
  }

  async function onChainChanged() {
    if (!state.provider) return;
    const net = await state.provider.getNetwork();
    state.chainId = net.chainId?.toString?.() || "";
    setWalletStatus();
  }

  async function signOwnership() {
    if (!state.signer) {
      $("status").textContent = "Connect MetaMask first.";
      $("status").className = "danger";
      return;
    }
    const address = $("address").value.trim();
    const proof = parseProof($("proof").value);
    if (!address || proof.length === 0) {
      $("status").textContent = "Provide address and proof before signing.";
      $("status").className = "danger";
      return;
    }
    const message = [
      "Fair Coin claim ownership check",
      `Address: ${address}`,
      `Merkle root: ${state.merkleRoot}`,
    ].join("\n");
    try {
      $("status").textContent = "Please confirm signature in MetaMask...";
      $("status").className = "pill";
      const signature = await state.signer.signMessage(message);
      $("signature").value = signature;
      $("status").textContent = "Ownership message signed with MetaMask.";
      $("status").className = "success";
    } catch (err) {
      console.error("Signing error:", err);
      $("status").textContent = err.code === 4001 ? "Signature was rejected in wallet." : "Signing failed.";
      $("status").className = "danger";
    }
  }

  $("account").addEventListener("change", (e) => selectAccount(Number(e.target.value)));

  $("btn-proof").addEventListener("click", () => {
    selectAccount(Number($("account").value || 0));
  });

  $("address").addEventListener("blur", async () => {
    const address = $("address").value.trim();
    if (!address) return;
    try {
      ethers.getAddress(address);
    } catch (err) {
      $("status").textContent = "Invalid Ethereum address format.";
      $("status").className = "danger";
      return;
    }
    try {
      $("status").textContent = "Checking eligibility...";
      $("status").className = "pill";
      const data = await fetchEligibility(address);
      applyEligibility(data);
    } catch (err) {
      console.error("Eligibility error:", err);
      $("status").textContent = err.message === "Request timeout after 10000ms" ? "Request timed out. Please try again." : "Eligibility lookup failed.";
      $("status").className = "danger";
    }
  });

  $("btn-verify").addEventListener("click", () => {
    const address = $("address").value.trim();
    const proof = parseProof($("proof").value);
    if (!address || proof.length === 0) {
      $("status").textContent = "Please provide an address and proof JSON.";
      return;
    }
    const ok = verifyProof(address, proof, state.merkleRoot);
    $("status").textContent = ok ? "Proof is valid for this Merkle root." : "Proof failed. Check address or proof.";
    $("status").className = ok ? "success" : "danger";
  });

  $("btn-connect").addEventListener("click", connectWallet);
  $("btn-sign").addEventListener("click", signOwnership);

  loadAirdrop().catch((err) => {
    $("status").textContent = "Failed to load airdrop.json";
    console.error(err);
  });
})();
