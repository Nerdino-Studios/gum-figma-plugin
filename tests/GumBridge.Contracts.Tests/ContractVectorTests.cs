using System;
using System.IO;
using System.Text.Json;
using GumBridge.Contracts;
using Xunit;

namespace GumBridge.Contracts.Tests;

public sealed class ContractVectorTests
{
    [Fact]
    public void BothLanguagesUseTheCheckedInVectors()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contract-vectors.json")));
        foreach (var vector in document.RootElement.EnumerateArray())
        {
            var name = vector.GetProperty("name").GetString();
            var kind = vector.GetProperty("kind").GetString()!;
            var valid = vector.GetProperty("valid").GetBoolean();
            Assert.True(WireContracts.Validate(kind, vector.GetProperty("value")) == valid, name);
        }
    }
}
