package imgui_test

import (
	"fmt"
	"testing"

	"github.com/AllenDang/imgui-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCurrentContextReturnsErrorIfNoContextIsCurrent(t *testing.T) {
	context, err := imgui.CurrentContext()
	assert.Nil(t, context, "No context expected")
	assert.Equal(t, imgui.ErrNoContext, err, "Error expected")
}

func TestCreateContextReturnsNewInstance(t *testing.T) {
	context := imgui.CreateContext(nil)
	require.NotNil(t, context, "Context expected")
	context.Destroy()
}

func TestCurrentContextCanBeRetrieved(t *testing.T) {
	context := imgui.CreateContext(nil)
	require.NotNil(t, context, "Context expected")
	defer context.Destroy()

	current, _ := imgui.CurrentContext()
	assert.NotNil(t, current, "Current context expected")
}

func TestCurrentContextCanBeChanged(t *testing.T) {
	context1 := imgui.CreateContext(nil)
	require.NotNil(t, context1, "Context expected")
	defer context1.Destroy()

	first, _ := imgui.CurrentContext()
	assert.True(t, context1.GetHandle() == first.GetHandle(), "First context expected")

	context2 := imgui.CreateContext(nil)
	require.NotNil(t, context2, "Context expected")
	defer context2.Destroy()

	_ = context2.SetCurrent()

	second, _ := imgui.CurrentContext()
	assert.True(t, context2.GetHandle() == second.GetHandle(), fmt.Sprintf("Context should have changed to second 1=%v, 2=%v", context1, context2))

	_ = context1.SetCurrent()

	third, _ := imgui.CurrentContext()
	assert.True(t, context1.GetHandle() == third.GetHandle(), fmt.Sprintf("Context should have changed to first 1=%v, 2=%v", context1, context2))
}

func TestDestroyDoesNothingWhenCalledMultipleTimes(t *testing.T) {
	context := imgui.CreateContext(nil)
	require.NotNil(t, context, "Context expected")

	context.Destroy()
	context.Destroy()
	context.Destroy()
}

func TestSetCurrentReturnsErrorWhenContextDestroyed(t *testing.T) {
	context := imgui.CreateContext(nil)
	require.NotNil(t, context, "Context expected")
	context.Destroy()

	err := context.SetCurrent()
	assert.Equal(t, imgui.ErrContextDestroyed, err)
}
