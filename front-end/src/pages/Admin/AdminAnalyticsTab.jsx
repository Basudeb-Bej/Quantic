//front-end/src/pages/Admin/AdminAnalyticsTab.jsx
import { useEffect, useMemo, useState } from "react";
import { fetchAnalytics } from "../../services/adminApi";

const buildZeroFilledDailySeries = (series, days = 30) => {
	const countsByDate = new Map((series || []).map((entry) => [entry.date, entry.count]));
	const result = [];
	const today = new Date();

	for (let i = days - 1; i >= 0; i -= 1) {
		const date = new Date(today);
		date.setDate(date.getDate() - i);
		const key = date.toISOString().slice(0, 10);
		result.push({ key, label: key.slice(5), value: countsByDate.get(key) || 0, tooltipLabel: key });
	}

	return result;
};

const getCurrentMonthValue = (series) => {
	if (!Array.isArray(series)) {
		return 0;
	}

	const now = new Date();
	const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
	const match = series.find((entry) => entry.date === currentKey);
	return match?.count || 0;
};

const splitLabelIntoLines = (label, maxCharsPerLine = 11) => {
	const words = String(label || "").split(" ");
	const lines = [];
	let currentLine = "";

	for (const word of words) {
		const candidate = currentLine ? `${currentLine} ${word}` : word;
		if (candidate.length > maxCharsPerLine && currentLine) {
			lines.push(currentLine);
			currentLine = word;
		} else {
			currentLine = candidate;
		}
	}
	if (currentLine) lines.push(currentLine);

	return lines.slice(0, 2);
};

function OverviewBarChart({ metrics }) {
	const barSlot = 78;
	const width = Math.max(640, metrics.length * barSlot);
	const height = 240;
	const margin = { top: 34, right: 20, bottom: 56, left: 46 };
	const plotWidth = width - margin.left - margin.right;
	const plotHeight = height - margin.top - margin.bottom;

	const rawMax = Math.max(1, ...metrics.map((entry) => entry.value));
	const step = Math.max(1, Math.ceil(rawMax / 4));
	const yTicks = [];
	for (let value = 0; value <= rawMax; value += step) {
		yTicks.push(value);
	}
	if (yTicks[yTicks.length - 1] < rawMax) {
		yTicks.push(yTicks[yTicks.length - 1] + step);
	}
	const yMax = yTicks[yTicks.length - 1] || 1;

	const barGap = 18;
	const barWidth = (plotWidth - barGap * (metrics.length - 1)) / metrics.length;
	const yFor = (value) => margin.top + plotHeight - (value / yMax) * plotHeight;
	const axisBottom = margin.top + plotHeight;
	const axisRight = margin.left + plotWidth;

	return (
		<div className="admin-overview-chart-scroll">
			<svg className="admin-bar-chart admin-bar-chart--overview" viewBox={`0 0 ${width} ${height}`} xmlns="http://www.w3.org/2000/svg">
				<defs>
					<linearGradient id="admin-overview-fill" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor="#9497fd" />
						<stop offset="100%" stopColor="#5b5fef" />
					</linearGradient>
				</defs>

				{yTicks.map((tick) => (
					<line
						key={`grid-${tick}`}
						x1={margin.left}
						y1={yFor(tick)}
						x2={axisRight}
						y2={yFor(tick)}
						className="admin-chart-gridline"
					/>
				))}

				<line x1={margin.left} y1={margin.top} x2={margin.left} y2={axisBottom} className="admin-chart-axis" />
				<line x1={margin.left} y1={axisBottom} x2={axisRight} y2={axisBottom} className="admin-chart-axis" />

				{yTicks.map((tick) => (
					<text key={`y-label-${tick}`} x={margin.left - 8} y={yFor(tick) + 3} textAnchor="end" className="admin-chart-tick-label">
						{tick}
					</text>
				))}

				{metrics.map((entry, index) => {
					const barHeight = (entry.value / yMax) * plotHeight;
					const x = margin.left + index * (barWidth + barGap);
					const y = axisBottom - barHeight;
					const lines = splitLabelIntoLines(entry.label);

					return (
						<g key={entry.label}>
							<rect
								x={x}
								y={y}
								width={barWidth}
								height={Math.max(0.5, barHeight)}
								rx="3"
								fill="url(#admin-overview-fill)"
							>
								<title>{`${entry.label}: ${entry.value}`}</title>
							</rect>
							<text x={x + barWidth / 2} y={y - 8} textAnchor="middle" className="admin-chart-value-label">
								{entry.value}
							</text>
							{lines.map((line, lineIndex) => (
								<text
									key={line}
									x={x + barWidth / 2}
									//y={axisBottom + 18 + lineIndex * 13}
									y={axisBottom + 12 + lineIndex * 10}
									textAnchor="middle"
									className="admin-chart-tick-label"
								>
									{line}
								</text>
							))}
						</g>
					);
				})}
			</svg>
		</div>
	);
}

function DonutChart({ segments, size = 118, strokeWidth = 16 }) {
	const total = segments.reduce((sum, segment) => sum + segment.value, 0) || 1;
	const radius = (size - strokeWidth) / 2;
	const circumference = 2 * Math.PI * radius;
	let offsetSoFar = 0;

	return (
		<div className="admin-donut">
			<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
				<circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--admin-line)" strokeWidth={strokeWidth} />
				{segments.map((segment) => {
					const fraction = segment.value / total;
					const dashLength = fraction * circumference;
					const dashArray = `${dashLength} ${circumference - dashLength}`;
					const dashOffset = -offsetSoFar * circumference;
					offsetSoFar += fraction;

					return (
						<circle
							key={segment.label}
							cx={size / 2}
							cy={size / 2}
							r={radius}
							fill="none"
							stroke={segment.color}
							strokeWidth={strokeWidth}
							strokeDasharray={dashArray}
							strokeDashoffset={dashOffset}
							transform={`rotate(-90 ${size / 2} ${size / 2})`}
							strokeLinecap={segments.length > 1 ? "butt" : "round"}
						/>
					);
				})}
			</svg>

			<div className="admin-donut__legend">
				{segments.map((segment) => (
					<div key={segment.label} className="admin-donut__legend-item">
						<span className="admin-donut__legend-dot" style={{ background: segment.color }} />
						<span className="admin-donut__legend-label">{segment.label}</span>
						<span className="admin-donut__legend-value">{segment.value}</span>
					</div>
				))}
			</div>
		</div>
	);
}

function AdminAnalyticsTab() {
	const [data, setData] = useState(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let isMounted = true;

		fetchAnalytics()
			.then((result) => {
				if (isMounted) setData(result);
			})
			.catch((err) => {
				if (isMounted) setError(err?.message || "Failed to load analytics.");
			})
			.finally(() => {
				if (isMounted) setLoading(false);
			});

		return () => {
			isMounted = false;
		};
	}, []);

	const overviewMetrics = useMemo(() => {
		if (!data) return [];

		return [
			// { label: "Total Users", value: data.users.total },
			{ label: "Active Users", value: Math.max(0, data.users.total - data.users.banned) },
			{ label: "Banned Users", value: data.users.banned },
			{ label: "Admins", value: data.users.admins },
			{ label: "New Today", value: data.users.newToday },
			{ label: "New 30 Days", value: data.users.newLast30Days },
			{ label: "Total Chats", value: data.chats.total },
			{ label: "Signups This Month", value: getCurrentMonthValue(data.signupSeriesMonthly) },
			{ label: "Messages This Month", value: getCurrentMonthValue(data.messageSeriesMonthly) },
			// { label: "2FA Enabled", value: data.security?.twoFactorEnabled ?? 0 },
			// { label: "Login Alerts On", value: data.security?.loginAlertsEnabled ?? 0 },
			// { label: "Security Coverage", value: data.security?.totalUsers ?? data.users.total },
		];
	}, [data]);

	if (loading) return <p>Loading analytics…</p>;
	if (error) return <p className="admin-error">{error}</p>;
	if (!data) return null;

	const activeUsers = Math.max(0, data.users.total - data.users.banned);
	const regularUsers = Math.max(0, data.users.total - data.users.admins);
	const securityTotal = data.security?.totalUsers ?? data.users.total;
	const twoFactorEnabled = data.security?.twoFactorEnabled ?? 0;
	const loginAlertsEnabled = data.security?.loginAlertsEnabled ?? 0;
	const fullyProtected = data.security?.fullyProtected ?? 0;

	return (
		<div className="admin-analytics">
			
			{/* <h2>Analytics</h2> */}
			<div className="admin-analytics__grid">
				<div className="admin-card">
					<span className="admin-card__label">Total users</span>
					<strong className="admin-card__value">{data.users.total}</strong>
				</div>
				<div className="admin-card">
					<span className="admin-card__label">Banned users</span>
					<strong className="admin-card__value">{data.users.banned}</strong>
				</div>
				<div className="admin-card">
					<span className="admin-card__label">Admins</span>
					<strong className="admin-card__value">{data.users.admins}</strong>
				</div>
				<div className="admin-card">
					<span className="admin-card__label">New today</span>
					<strong className="admin-card__value">{data.users.newToday}</strong>
				</div>
				<div className="admin-card">
					<span className="admin-card__label">New (7 days)</span>
					<strong className="admin-card__value">{data.users.newLast7Days}</strong>
				</div>
				<div className="admin-card">
					<span className="admin-card__label">New (30 days)</span>
					<strong className="admin-card__value">{data.users.newLast30Days}</strong>
				</div>
				<div className="admin-card">
					<span className="admin-card__label">Total chats</span>
					<strong className="admin-card__value">{data.chats.total}</strong>
				</div>
				<div className="admin-card">
					<span className="admin-card__label">Total messages</span>
					<strong className="admin-card__value">{data.messages.total}</strong>
				</div>
				<div className="admin-card">
					<span className="admin-card__label">Messages (7 days)</span>
					<strong className="admin-card__value">{data.messages.last7Days}</strong>
				</div>
			</div>

			<div className="admin-chart-card admin-overview-card">
				<h3>System overview</h3>
				<OverviewBarChart metrics={overviewMetrics} />
			</div>

			<div className="admin-chart-row admin-chart-row--breakdown">
				<div className="admin-chart-card">
					<h3>Breakdown</h3>
					<div className="admin-donut-row">
						<DonutChart
							segments={[
								{ label: "Active", value: activeUsers, color: "#35d6a4" },
								{ label: "Banned", value: data.users.banned, color: "#ff6b6b" },
							]}
						/>
						<DonutChart
							segments={[
								{ label: "Users", value: regularUsers, color: "#7b7ffc" },
								{ label: "Admins", value: data.users.admins, color: "#ffb84d" },
							]}
						/>
					</div>
				</div>

				<div className="admin-chart-card">
					<h3>Security metrics</h3>
					<div className="admin-security-metrics-row">
						<div className="admin-security-metrics-left">
							<DonutChart
								segments={[
									{ label: "2FA enabled", value: twoFactorEnabled, color: "#35d6a4" },
									{ label: "2FA disabled", value: Math.max(0, securityTotal - twoFactorEnabled), color: "#ff6b6b" },
								]}
							/>
							<DonutChart
								segments={[
									{ label: "Alerts on", value: loginAlertsEnabled, color: "#7b7ffc" },
									{ label: "Alerts off", value: Math.max(0, securityTotal - loginAlertsEnabled), color: "#ffb84d" },
								]}
							/>
						</div>
						<div className="admin-security-metrics-right">
							<DonutChart
								segments={[
									{ label: "Fully protected", value: fullyProtected, color: "#35d6a4" },
									{ label: "Not fully protected", value: Math.max(0, securityTotal - fullyProtected), color: "#ff6b6b" },
								]}
							/>
						</div>
					</div>
				</div>
			</div>

		</div>
	);
}

export default AdminAnalyticsTab;