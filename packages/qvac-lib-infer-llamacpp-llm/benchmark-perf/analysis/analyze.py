import argparse
import glob
import json
import os

import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
from sklearn.decomposition import PCA


def read_jsonl(path):
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def load_results(input_dir):
    files = glob.glob(os.path.join(input_dir, "*.jsonl"))
    rows = []
    for file_path in files:
        rows.extend(read_jsonl(file_path))
    return pd.DataFrame(rows)


def normalize_memory(df):
    if "memory" not in df:
        return df
    memory = df["memory"].apply(lambda x: x if isinstance(x, dict) else {})
    for stage in ["load", "end", "unload"]:
        df[f"memory_{stage}_rss"] = memory.apply(lambda m: (m.get(stage) or {}).get("rssBytes"))
    return df


def min_max(series):
    if series.empty:
        return series
    min_val = series.min()
    max_val = series.max()
    if min_val == max_val:
        return series.apply(lambda _: 0.5)
    return (series - min_val) / (max_val - min_val)


def compute_score(df):
    weights = {
        "ttftMs": -0.3,
        "tps": 0.3,
        "promptTokensPerTtft": 0.1,
        "modelLoadMs": -0.1,
        "modelUnloadMs": -0.05,
        "memory_end_rss": -0.05,
        "accuracyScore": 0.2
    }

    # Initialize score as a Series of zeros with the DataFrame's index
    # This ensures each row gets its own score calculated independently
    score = pd.Series(0.0, index=df.index)
    for metric, weight in weights.items():
        if metric not in df.columns:
            continue
        normalized = min_max(df[metric].fillna(df[metric].median()))
        score += normalized * weight
    df["score"] = score
    return df


def aggregate_metrics_mean(df):
    group_cols = ["modelId", "perfParam", "perfValue", "promptId", "platform", "arch", "backend", "impl"]
    metrics = ["ttftMs", "tps", "modelLoadMs", "modelUnloadMs", "promptTokensPerTtft", "accuracyScore"]
    available = [m for m in metrics if m in df.columns]
    grouped = df.groupby(group_cols, dropna=False)[available].mean().reset_index()
    return grouped


def aggregate_metrics_mean_std(df):
    group_cols = ["modelId", "perfParam", "perfValue", "promptId", "platform", "arch", "backend", "impl"]
    metrics = ["ttftMs", "tps", "modelLoadMs", "modelUnloadMs", "promptTokensPerTtft", "accuracyScore"]
    available = [m for m in metrics if m in df.columns]
    grouped = df.groupby(group_cols, dropna=False)[available].agg(["mean", "std"]).reset_index()
    grouped.columns = ["_".join(col).strip("_") for col in grouped.columns.values]
    return grouped


def pareto_front(df, minimize_cols, maximize_cols):
    candidates = df.copy()
    is_pareto = []
    for _, row in candidates.iterrows():
        dominated = False
        for _, other in candidates.iterrows():
            if row.equals(other):
                continue
            better_or_equal = True
            strictly_better = False
            for col in minimize_cols:
                if other[col] > row[col]:
                    better_or_equal = False
                    break
                if other[col] < row[col]:
                    strictly_better = True
            if not better_or_equal:
                continue
            for col in maximize_cols:
                if other[col] < row[col]:
                    better_or_equal = False
                    break
                if other[col] > row[col]:
                    strictly_better = True
            if better_or_equal and strictly_better:
                dominated = True
                break
        is_pareto.append(not dominated)
    return candidates[is_pareto]


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def plot_param_effects(df, output_dir):
    metrics = ["ttftMs", "tps", "modelLoadMs", "modelUnloadMs"]
    if "accuracyScore" in df.columns:
        metrics.append("accuracyScore")
    for param in sorted(df["perfParam"].dropna().unique()):
        subset = df[df["perfParam"] == param]
        if subset.empty:
            continue
        for metric in metrics:
            if metric not in subset.columns:
                continue
            plt.figure(figsize=(10, 5))
            sns.lineplot(
                data=subset,
                x="perfValue",
                y=metric,
                hue="impl",
                marker="o",
                estimator="mean",
                errorbar="sd"
            )
            plt.title(f"{param} vs {metric}")
            plt.tight_layout()
            plt.savefig(os.path.join(output_dir, f"param_{param}_{metric}.png"))
            plt.close()


def plot_prompt_throughput(df, output_dir):
    if "promptTokensPerTtft" not in df.columns:
        return
    subset = df[df["perfParam"] == "ctx_size"]
    if subset.empty:
        return
    plt.figure(figsize=(10, 5))
    sns.lineplot(
        data=subset,
        x="perfValue",
        y="promptTokensPerTtft",
        hue="impl",
        marker="o",
        estimator="mean",
        errorbar="sd"
    )
    plt.title("PromptTokens/TTFT by ctx_size")
    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, "prompt_tokens_per_ttft.png"))
    plt.close()


def plot_pca(df, output_dir):
    numeric_cols = ["ttftMs", "tps", "modelLoadMs", "modelUnloadMs"]
    clean = df[numeric_cols].dropna()
    if clean.empty:
        return
    pca = PCA(n_components=2)
    components = pca.fit_transform(clean)
    plt.figure(figsize=(8, 6))
    plt.scatter(components[:, 0], components[:, 1], alpha=0.6)
    plt.title("PCA of performance metrics")
    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, "pca_metrics.png"))
    plt.close()


def plot_qvac_vs_torch(df, output_dir):
    if "impl" not in df.columns:
        return
    merged = df.pivot_table(
        index=["modelId", "perfParam", "perfValue", "promptId", "platform", "arch", "backend"],
        columns="impl",
        values=["ttftMs", "tps", "modelLoadMs", "modelUnloadMs"],
        aggfunc="mean"
    )
    if merged.empty:
        return
    merged.columns = ["_".join(col).strip() for col in merged.columns.values]
    merged = merged.reset_index()

    for metric in ["ttftMs", "tps"]:
        qvac_col = f"{metric}_qvac"
        torch_col = f"{metric}_pytorch"
        if qvac_col not in merged.columns or torch_col not in merged.columns:
            continue
        merged[f"{metric}_delta"] = merged[qvac_col] - merged[torch_col]
        plot_data = merged[["perfParam", f"{metric}_delta"]].dropna()
        if plot_data.empty or plot_data["perfParam"].nunique() == 0:
            continue
        plt.figure(figsize=(10, 5))
        sns.boxplot(data=plot_data, x="perfParam", y=f"{metric}_delta")
        plt.xticks(rotation=45, ha="right")
        plt.title(f"QVAC - PyTorch {metric} delta by perfParam")
        plt.tight_layout()
        plt.savefig(os.path.join(output_dir, f"qvac_vs_torch_{metric}_delta.png"))
        plt.close()


def plot_memory(df, output_dir):
    if "memory_end_rss" not in df.columns:
        return
    for param in sorted(df["perfParam"].dropna().unique()):
        subset = df[df["perfParam"] == param]
        if subset.empty:
            continue
        plt.figure(figsize=(10, 5))
        sns.lineplot(
            data=subset,
            x="perfValue",
            y="memory_end_rss",
            hue="impl",
            marker="o",
            estimator="mean",
            errorbar="sd"
        )
        plt.title(f"Memory RSS (end) by {param}")
        plt.tight_layout()
        plt.savefig(os.path.join(output_dir, f"memory_rss_end_{param}.png"))
        plt.close()


def plot_score(df, output_dir):
    if "score" not in df.columns:
        return
    for param in sorted(df["perfParam"].dropna().unique()):
        subset = df[df["perfParam"] == param]
        if subset.empty:
            continue
        plt.figure(figsize=(10, 5))
        sns.lineplot(
            data=subset,
            x="perfValue",
            y="score",
            hue="impl",
            marker="o",
            estimator="mean",
            errorbar="sd"
        )
        plt.title(f"Composite score by {param}")
        plt.tight_layout()
        plt.savefig(os.path.join(output_dir, f"score_by_param_{param}.png"))
        plt.close()


def write_best_configs(df, output_dir):
    grouped = aggregate_metrics_mean(df)
    outputs = []
    for (model_id, platform, arch, backend, impl), subset in grouped.groupby(["modelId", "platform", "arch", "backend", "impl"]):
        subset = subset.dropna(subset=["ttftMs", "tps"])
        if subset.empty:
            continue
        pareto = pareto_front(subset, minimize_cols=["ttftMs"], maximize_cols=["tps"])
        pareto["modelId"] = model_id
        pareto["platform"] = platform
        pareto["arch"] = arch
        pareto["backend"] = backend
        pareto["impl"] = impl
        outputs.append(pareto)
    if outputs:
        result = pd.concat(outputs, ignore_index=True)
        result.to_csv(os.path.join(output_dir, "best_configs_pareto.csv"), index=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=os.path.join(os.path.dirname(__file__), "..", "results"))
    parser.add_argument("--output", default=os.path.join(os.path.dirname(__file__), "plots"))
    args = parser.parse_args()

    df = load_results(args.input)
    if df.empty:
        raise SystemExit("No results found")

    ensure_dir(args.output)

    df = normalize_memory(df)
    df = compute_score(df)

    summary = aggregate_metrics_mean_std(df)
    if not summary.empty:
        summary.to_csv(os.path.join(args.output, "summary_mean_std.csv"), index=False)

    plot_param_effects(df, args.output)
    plot_prompt_throughput(df, args.output)
    plot_pca(df, args.output)
    plot_qvac_vs_torch(df, args.output)
    plot_memory(df, args.output)
    plot_score(df, args.output)
    write_best_configs(df, args.output)


if __name__ == "__main__":
    main()
