// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice ERC20 token that embeds an ownerless constant-product market maker.
/// Merkle claims mint 100 FAIR; 95 FAIR go to the claimer and 5 FAIR seed the pool.
/// Selling FAIR for ETH has a 0.1% fee that routes to the founder; buying FAIR with ETH is fee-free.
contract FairCoin is Pausable {
    /*//////////////////////////////////////////////////////////////
                                ERC20
    //////////////////////////////////////////////////////////////*/

    string public constant name = "Fair Coin";
    string public constant symbol = "FAIR";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) internal _balances;
    mapping(address => mapping(address => uint256)) internal _allowances;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                            AIRDROP + ADMIN
    //////////////////////////////////////////////////////////////*/

    address public immutable founder;
    bytes32 public immutable merkleRoot;
    uint256 public constant CLAIM_AMOUNT = 100 * 1e18;
    uint256 public constant POOL_DIVISOR = 20;
    uint256 public constant FEE_DENOMINATOR = 1000;
    uint256 public constant MAX_SUPPLY = 1_000_000_000 * 1e18;
    uint256 public constant POOL_CUT = 5 * 1e18;
    uint256 public constant USER_CUT = 95 * 1e18;

    mapping(address => bool) public claimed;

    event Claimed(address indexed account, uint256 userAmount, uint256 poolAmount);

    /*//////////////////////////////////////////////////////////////
                               AMM STATE
    //////////////////////////////////////////////////////////////*/

    uint256 public reserveFair;
    uint256 public reserveEth;

    event Sync(uint256 reserveFair, uint256 reserveEth);
    event Donation(address indexed from, uint256 fairAmount, uint256 ethAmount);
    event Buy(address indexed buyer, uint256 ethIn, uint256 fairOut);
    event Sell(address indexed seller, uint256 fairIn, uint256 fee, uint256 ethOut);
    event EthReceived(address indexed from, uint256 amount);

    bool private _locked;

    modifier nonReentrant() {
        require(!_locked, "REENTRANCY");
        _locked = true;
        _;
        _locked = false;
    }

    constructor(bytes32 _merkleRoot, address _founder) {
        require(_founder != address(0), "FOUNDER_REQUIRED");
        require(_merkleRoot != bytes32(0), "INVALID_MERKLE_ROOT");
        founder = _founder;
        merkleRoot = _merkleRoot;
    }

    function pause() external {
        require(msg.sender == founder, "NOT_FOUNDER");
        _pause();
    }

    function unpause() external {
        require(msg.sender == founder, "NOT_FOUNDER");
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                             ERC20 LOGIC
    //////////////////////////////////////////////////////////////*/

    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) public view returns (uint256) {
        return _allowances[owner][spender];
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        require(spender != address(0), "ZERO_SPENDER");
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        require(allowed >= amount, "ALLOWANCE");
        _allowances[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "ZERO_TO");
        uint256 bal = _balances[from];
        require(bal >= amount, "BALANCE");
        unchecked {
            _balances[from] = bal - amount;
            _balances[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        require(to != address(0), "ZERO_ADDRESS");
        require(totalSupply + amount <= MAX_SUPPLY, "MAX_SUPPLY");
        unchecked {
            totalSupply += amount;
            _balances[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                           MERKLE CLAIMING
    //////////////////////////////////////////////////////////////*/

    function claim(bytes32[] calldata proof) external nonReentrant whenNotPaused {
        require(!claimed[msg.sender], "ALREADY_CLAIMED");
        require(_verify(proof, msg.sender), "INVALID_PROOF");

        require(totalSupply + USER_CUT + POOL_CUT <= MAX_SUPPLY, "MAX_SUPPLY");

        claimed[msg.sender] = true;
        _mint(msg.sender, USER_CUT);
        _mint(address(this), POOL_CUT);

        _sync();
        emit Claimed(msg.sender, USER_CUT, POOL_CUT);
    }

    function _verify(bytes32[] calldata proof, address account) internal view returns (bool) {
        bytes32 leaf = keccak256(abi.encodePacked(account));
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            if (computed < sibling) {
                computed = keccak256(abi.encodePacked(computed, sibling));
            } else {
                computed = keccak256(abi.encodePacked(sibling, computed));
            }
        }
        return computed == merkleRoot;
    }

    /*//////////////////////////////////////////////////////////////
                              AMM LOGIC
    //////////////////////////////////////////////////////////////*/

    function donate(uint256 fairAmount) external payable nonReentrant {
        require(fairAmount > 0 || msg.value > 0, "DONATE_ZERO");
        
        if (fairAmount > 0) {
            _transfer(msg.sender, address(this), fairAmount);
        }
        _sync();
        emit Donation(msg.sender, fairAmount, msg.value);
    }

    function buyFair(uint256 minAmountOut, uint256 deadline) external payable nonReentrant whenNotPaused {
        require(block.timestamp <= deadline, "EXPIRED");
        require(msg.value > 0, "ZERO_IN");
        uint256 fairOut = _getAmountOut(msg.value, reserveEth, reserveFair);
        require(fairOut > 0, "NO_LIQUIDITY");
        require(fairOut >= minAmountOut, "SLIPPAGE_EXCEEDED");

        _transfer(address(this), msg.sender, fairOut);
        _sync();
        emit Buy(msg.sender, msg.value, fairOut);
    }

    function sellFair(uint256 fairAmount, uint256 minEthOut, uint256 deadline) external nonReentrant whenNotPaused {
        require(block.timestamp <= deadline, "EXPIRED");
        require(fairAmount > 0, "ZERO_IN");

        _transfer(msg.sender, address(this), fairAmount);

        uint256 fee = fairAmount / FEE_DENOMINATOR;
        if (fee == 0 && fairAmount > 0) {
            fee = 1;
        }
        uint256 amountInAfterFee = fairAmount - fee;

        _transfer(address(this), founder, fee);

        uint256 ethOut = _getAmountOut(amountInAfterFee, reserveFair, reserveEth);
        require(ethOut > 0, "NO_LIQUIDITY");
        require(ethOut >= minEthOut, "SLIPPAGE_EXCEEDED");
        require(ethOut <= address(this).balance, "INSUFFICIENT_ETH");

        (bool ok, ) = msg.sender.call{value: ethOut}("");
        require(ok, "ETH_SEND_FAIL");

        _sync();
        emit Sell(msg.sender, fairAmount, fee, ethOut);
    }

    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) return 0;
        uint256 numerator = reserveOut * amountIn;
        uint256 denominator = reserveIn + amountIn;
        return numerator / denominator;
    }

    function _sync() internal {
        reserveFair = _balances[address(this)];
        reserveEth = address(this).balance;
        emit Sync(reserveFair, reserveEth);
    }

    receive() external payable nonReentrant {
        if (msg.value > 0) {
            emit EthReceived(msg.sender, msg.value);
        }
        _sync();
    }
}
