"""least squares without numpy: normal equations, optional ridge, optional NNLS."""


def solve(A, b):
    """gaussian elimination with partial pivoting on a square system."""
    n = len(A)
    M = [list(row) + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        if abs(M[p][c]) < 1e-12:
            M[c][c] += 1e-9
            p = c
        M[c], M[p] = M[p], M[c]
        pv = M[c][c]
        for r in range(n):
            if r == c:
                continue
            f = M[r][c] / pv
            if f:
                for k in range(c, n + 1):
                    M[r][k] -= f * M[c][k]
    return [M[i][n] / M[i][i] for i in range(n)]


def lstsq(X, y, ridge=0.0):
    n = len(X[0])
    A = [[sum(X[r][i] * X[r][j] for r in range(len(X))) + (ridge if i == j else 0.0)
          for j in range(n)] for i in range(n)]
    b = [sum(X[r][i] * y[r] for r in range(len(X))) for i in range(n)]
    return solve(A, b)


def nnls(X, y, iters=20000, ridge=1e-9):
    """projected gradient descent with a non-negativity clamp.

    Weights here are points per token; a negative one would mean a token kind
    gives limit back, which the meter cannot do, so the clamp is the model.
    """
    m, n = len(X), len(X[0])
    G = [[sum(X[r][i] * X[r][j] for r in range(m)) + (ridge if i == j else 0.0)
          for j in range(n)] for i in range(n)]
    c = [sum(X[r][i] * y[r] for r in range(m)) for i in range(n)]
    L = sum(abs(G[i][j]) for i in range(n) for j in range(n)) or 1.0
    w = [0.0] * n
    for _ in range(iters):
        g = [sum(G[i][j] * w[j] for j in range(n)) - c[i] for i in range(n)]
        w = [max(0.0, w[i] - g[i] / L) for i in range(n)]
    return w


def stats(X, y, w):
    pred = [sum(X[r][i] * w[i] for i in range(len(w))) for r in range(len(X))]
    res = [y[r] - pred[r] for r in range(len(y))]
    ybar = sum(y) / len(y)
    ss_res = sum(r * r for r in res)
    ss_tot = sum((v - ybar) ** 2 for v in y) or 1e-12
    rmse = (ss_res / len(y)) ** 0.5
    mae = sum(abs(r) for r in res) / len(y)
    return {"r2": 1 - ss_res / ss_tot, "rmse": rmse, "mae": mae,
            "pred": pred, "res": res}
