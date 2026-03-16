#!/usr/bin/env python3
"""
Data Analysis Weather - Small Version
Analyzes weather data and generates basic statistics.
"""

import json
import statistics
from datetime import datetime

class WeatherAnalyzer:
    def __init__(self):
        self.temperature_data = []
        self.humidity_data = []
        
    def load_sample_data(self):
        """Load sample weather data for analysis."""
        self.weather_records = [
            {"date": "2024-03-01", "temp": 68, "humidity": 45, "precipitation": 0.0},
            {"date": "2024-03-02", "temp": 72, "humidity": 52, "precipitation": 0.1},
            {"date": "2024-03-03", "temp": 69, "humidity": 48, "precipitation": 0.0},
            {"date": "2024-03-04", "temp": 75, "humidity": 41, "precipitation": 0.0},
            {"date": "2024-03-05", "temp": 71, "humidity": 55, "precipitation": 0.3}
        ]
        
        for record in self.weather_records:
            self.temperature_data.append(record['temp'])
            self.humidity_data.append(record['humidity'])
    
    def calculate_statistics(self):
        """Calculate basic weather statistics."""
        if not self.temperature_data:
            return None
            
        stats = {
            'temperature': {
                'avg': round(statistics.mean(self.temperature_data), 2),
                'min': min(self.temperature_data),
                'max': max(self.temperature_data),
                'median': statistics.median(self.temperature_data)
            },
            'humidity': {
                'avg': round(statistics.mean(self.humidity_data), 2),
                'min': min(self.humidity_data),
                'max': max(self.humidity_data),
                'median': statistics.median(self.humidity_data)
            }
        }
        
        return stats
    
    def generate_report(self):
        """Generate a weather analysis report."""
        stats = self.calculate_statistics()
        if not stats:
            return "No data available for analysis."
            
        report = f"""
WEATHER ANALYSIS REPORT
=======================
Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

TEMPERATURE STATISTICS:
- Average: {stats['temperature']['avg']}°F
- Range: {stats['temperature']['min']}°F - {stats['temperature']['max']}°F
- Median: {stats['temperature']['median']}°F

HUMIDITY STATISTICS:
- Average: {stats['humidity']['avg']}%
- Range: {stats['humidity']['min']}% - {stats['humidity']['max']}%
- Median: {stats['humidity']['median']}%

Total records analyzed: {len(self.weather_records)}
        """
        
        return report.strip()

def main():
    """Main execution function."""
    analyzer = WeatherAnalyzer()
    analyzer.load_sample_data()
    
    print("Weather Data Analysis")
    print("=" * 20)
    print(analyzer.generate_report())

if __name__ == "__main__":
    main()
